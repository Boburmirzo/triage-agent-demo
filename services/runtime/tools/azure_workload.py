"""Environment-aware resource relationships and bounded cross-layer diagnostics."""
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
from urllib.parse import urlencode

APP = 'microsoft.app/containerapps'
INSIGHTS = 'microsoft.insights/components'
WORKSPACE = 'microsoft.operationalinsights/workspaces'
POSTGRES = 'microsoft.dbforpostgresql/flexibleservers'


def matches_environment(name, environment):
    name = name.lower()
    return environment == 'all' or ('staging' in name if environment == 'staging' else 'prod' in name)


def safe_excerpt(value):
    text = str(value or '')
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            text = str(obj.get('message', obj.get('msg', obj.get('event', '[Structured payload omitted]'))))
    except (ValueError, TypeError):
        pass
    # Never return payloads, SQL text, credentials or arbitrary structured objects.
    if re.search(r'(?i)\b(password|pwd|secret|token|bearer|authorization|api.?key|accountkey|connectionstring|request.?body|payload|headers?|statement|select\s+.+\s+from|insert\s+into|update\s+\w+\s+set|delete\s+from)\b', text):
        return '[Sensitive payload or SQL text omitted]'
    text = re.sub(r'(?i)\b(?:postgres(?:ql)?|mysql|redis)://\S+', '[Connection URL omitted]', text)
    text = re.sub(r'(?i)(https?://[^\s?]+)\?[^\s]+', r'\1?[Query omitted]', text)
    text = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[Token omitted]', text)
    text = re.sub(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[Email omitted]', text)
    return text[:400]


def table_rows(result):
    if isinstance(result, list):
        return result
    rows = []
    for table in result.get('tables', []):
        names = [c['name'] for c in table['columns']]
        rows.extend(dict(zip(names, row)) for row in table['rows'])
    return rows


def metric_summary(result):
    summaries = []
    for metric in result.get('value', []):
        samples = [sample for series in metric.get('timeseries', []) for sample in series.get('data', [])]
        values = [sample[key] for sample in samples for key in ('average', 'maximum', 'minimum', 'total', 'count') if isinstance(sample.get(key), (int, float))]
        totals = [s['total'] for s in samples if isinstance(s.get('total'), (int, float))]
        summaries.append({'metric': metric['name']['value'], 'unit': metric.get('unit'), 'samples': len(values), 'total': sum(totals) if totals else None,
                          'min': min(values) if values else None, 'max': max(values) if values else None,
                          'meanOfBuckets': round(sum(values) / len(values), 3) if values else None,
                          'last': values[-1] if values else None})
    return summaries


class Workload:
    def __init__(self, az, items, subscription, group, environment='all', hours=1):
        self.az = az
        self.items = items
        self.known = {r['id'].lower(): r for r in items}
        self.subscription = subscription
        self.group = group
        self.environment = environment
        self.hours = hours
        self.end = datetime.now(timezone.utc)
        self.start = self.end - timedelta(hours=hours)
        self.cache = {}

    def metadata(self, resource):
        key = resource.lower()
        if key not in self.known:
            raise ValueError('Related resource is outside the configured group inventory')
        if key not in self.cache:
            self.cache[key] = self.az(['resource', 'show', '--ids', self.known[key]['id'], '--subscription', self.subscription])
        return self.cache[key]

    def related(self, root):
        selected = self.known[root.lower()]
        if not matches_environment(selected['name'], self.environment):
            raise ValueError('Selected resource does not match the selected environment')
        relationships, gaps = [], []
        included = set()

        def add(resource, reason, via=None):
            key = resource.lower()
            if key not in self.known:
                gaps.append({'signal': 'relationship', 'status': 'outside-scope', 'reason': 'A linked resource is outside this resource group.'})
                return
            item = self.known[key]
            # A staging investigation cannot cross into explicitly production-named resources.
            opposite = self.environment != 'all' and matches_environment(item['name'], 'production' if self.environment == 'staging' else 'staging')
            if opposite and not matches_environment(item['name'], self.environment):
                gaps.append({'signal': 'relationship', 'status': 'excluded', 'reason': 'A link points to a different named environment.'})
                return
            if key not in included:
                included.add(key)
                relationships.append({**item, 'relationship': reason, 'via': via, 'links': [{'relationship': reason, 'via': via}], 'shared': not matches_environment(item['name'], self.environment)})
            else:
                entry = next(r for r in relationships if r['id'].lower() == key)
                link = {'relationship': reason, 'via': via}
                if link not in entry['links']:
                    entry['links'].append(link)

        add(root, 'selected-resource')

        def stem(name):
            return '-'.join(p for p in name.lower().split('-') if p not in ('api', 'appinsights', 'insights'))

        if selected['type'].lower() in (APP, INSIGHTS):
            for item in self.items:
                if item['type'].lower() in (APP, INSIGHTS) and matches_environment(item['name'], self.environment) and stem(item['name']) == stem(selected['name']):
                    add(item['id'], 'same-workload-name (candidate, not proof of telemetry wiring)', root)

        # Follow actual app configuration references without returning any environment values.
        for item in list(relationships):
            kind = item['type'].lower()
            try:
                props = self.metadata(item['id']).get('properties', {})
                if kind == INSIGHTS and props.get('WorkspaceResourceId'):
                    add(props['WorkspaceResourceId'], 'application-insights-workspace', item['id'])
                if kind != APP:
                    continue
                environment_id = props.get('managedEnvironmentId') or props.get('environmentId')
                if environment_id:
                    add(environment_id, 'container-managed-environment', item['id'])
                    if environment_id.lower() in included:
                        environment = self.metadata(environment_id).get('properties', {})
                        customer = environment.get('appLogsConfiguration', {}).get('logAnalyticsConfiguration', {}).get('customerId')
                        if customer:
                            for workspace in self.items:
                                if workspace['type'].lower() == WORKSPACE and self.metadata(workspace['id']).get('properties', {}).get('customerId') == customer:
                                    add(workspace['id'], 'container-log-workspace', item['id'])
                values = [entry.get('value', '') for container in props.get('template', {}).get('containers', []) for entry in container.get('env', [])]
                found_db = False
                mapping_environment = self.environment
                if mapping_environment == 'all':
                    mapping_environment = 'staging' if matches_environment(item['name'], 'staging') else 'production' if matches_environment(item['name'], 'production') else 'all'
                configured = {name.strip().lower() for name in os.environ.get(f'AZURE_{mapping_environment.upper()}_DATABASE_SERVERS', '').split(',') if name.strip()}
                for candidate in self.items:
                    if candidate['type'].lower() != POSTGRES:
                        continue
                    host = candidate['name'].lower() + '.postgres.database.azure.com'
                    if candidate['name'].lower() in configured:
                        add(candidate['id'], 'operator-confirmed environment database (server-wide shared metrics)', item['id'])
                        found_db = found_db or candidate['id'].lower() in included
                    elif any(re.search(r'(?<![\w.-])' + re.escape(host) + r'(?![\w.-])', str(value).lower()) for value in values):
                        add(candidate['id'], 'database-host-reference (server-wide shared metrics)', item['id'])
                        found_db = found_db or candidate['id'].lower() in included
                if not found_db:
                    gaps.append({'resource': item['id'], 'signal': 'database-relationship', 'status': 'unresolved', 'reason': 'No database hostname was visible in non-secret app configuration. Secret values were not read; do not assume an unrelated database is a dependency.'})
            except Exception:
                gaps.append({'resource': item['id'], 'signal': 'relationships', 'status': 'unavailable', 'reason': 'Related resource metadata could not be read.'})

        for item in list(relationships):
            if item['type'].lower() != POSTGRES:
                continue
            try:
                settings = self.az(['monitor', 'diagnostic-settings', 'list', '--resource', item['id'], '--subscription', self.subscription])
                for setting in settings if isinstance(settings, list) else settings.get('value', []):
                    if setting.get('workspaceId'):
                        add(setting['workspaceId'], 'database-log-workspace', item['id'])
            except Exception:
                gaps.append({'resource': item['id'], 'signal': 'database-log-routing', 'status': 'unavailable', 'reason': 'Database diagnostic settings could not be read.'})
        return {'selectedResource': root, 'environment': self.environment, 'resources': relationships, 'gaps': gaps}

    def query_workspace(self, workspace, query):
        customer = self.metadata(workspace)['properties']['customerId']
        return table_rows(self.az(['monitor', 'log-analytics', 'query', '--workspace', customer, '--analytics-query', query, '--subscription', self.subscription]))

    def logs(self, workspace, resource, table):
        if table not in ('ContainerAppConsoleLogs_CL', 'ContainerAppSystemLogs_CL', 'PostgreSQLFlexServerLogs', 'AzureDiagnostics'):
            raise ValueError('Unsupported workload log table')
        if self.known[workspace.lower()]['type'].lower() != WORKSPACE:
            raise ValueError('Select a Log Analytics workspace')
        item = self.known[resource.lower()]
        # Values are taken from verified inventory and encoded as KQL string literals.
        resource_literal = json.dumps(item['id'])
        name_literal = json.dumps(item['name'])
        window = f'TimeGenerated between (datetime({self.start.isoformat()}) .. datetime({self.end.isoformat()}))'
        if table.startswith('ContainerApp'):
            query = f'''let scoped = {table} | where {window}
| where tostring(column_ifexists("ContainerAppName_s", "")) =~ {name_literal}
| extend Severity=tostring(column_ifexists("LogLevel_s", column_ifexists("Level", ""))), Message=tostring(column_ifexists("Log_s", column_ifexists("Reason_s", ""))), Revision=tostring(column_ifexists("RevisionName_s", ""));
union (scoped | where Message has_any ("error", "exception", "failed", "timeout", "killed", "unhealthy", "warning") | top 25 by TimeGenerated desc), (scoped | top 25 by TimeGenerated desc)
| project TimeGenerated, Severity, Message, Revision | distinct * | top 50 by TimeGenerated desc'''
        else:
            # Database logs on shared servers are aggregated; SQL text and row data never leave the runtime.
            query = f'''{table} | where {window} | where _ResourceId =~ {resource_literal}
| extend Severity=tostring(column_ifexists("ErrorLevel", column_ifexists("errorLevel_s", column_ifexists("Level", "")))), ErrorCode=tostring(column_ifexists("SqlErrorCode", column_ifexists("sqlerrcode_s", ""))), Message=tostring(column_ifexists("Message", column_ifexists("msg_s", "")))
| summarize events=count(), timeouts=countif(Message contains "timeout"), deadlocks=countif(Message contains "deadlock"), connectionFailures=countif(Message contains "connection" and Message has_any ("failed", "rejected", "fatal")) by bin(TimeGenerated, 5m), Severity, ErrorCode | top 50 by TimeGenerated desc'''
        rows = self.query_workspace(workspace, query)
        for row in rows:
            if 'Message' in row:
                row['Message'] = safe_excerpt(row['Message'])
        return rows

    def container_tail(self, resource, log_type):
        item = self.known[resource.lower()]
        command = ['az', 'containerapp', 'logs', 'show', '--name', item['name'], '--resource-group', self.group,
                   '--subscription', self.subscription, '--type', log_type, '--tail', '50', '--format', 'json', '--follow', 'false', '--only-show-errors']
        if log_type == 'console':
            props = self.metadata(resource).get('properties', {})
            containers = props.get('template', {}).get('containers', [])
            if containers:
                command += ['--container', containers[0]['name']]
            if props.get('latestReadyRevisionName'):
                command += ['--revision', props['latestReadyRevisionName']]
        response = subprocess.run(command, capture_output=True, text=True, timeout=45)
        if response.returncode:
            raise ValueError('Direct container logs unavailable')
        rows, outside, undated = [], 0, 0
        for line in response.stdout.splitlines():
            try:
                event = json.loads(line)
                text = event.get('Log', event.get('message', ''))
                if re.match(r'(?i)(connecting to|successfully connected|disconnecting from)', str(text)):
                    continue
                timestamp = event.get('TimeStamp', event.get('timeStamp', ''))
                instant = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
                if instant.tzinfo is None:
                    undated += 1
                    continue
                if self.start <= instant <= self.end:
                    rows.append({'TimeGenerated': timestamp, 'Message': safe_excerpt(text)})
                else:
                    outside += 1
            except (ValueError, AttributeError, TypeError):
                undated += 1
        return {'events': rows, 'tailLimit': 50, 'excludedOutsideWindow': outside, 'unparseableOrUndated': undated,
                'coverage': 'Latest bounded tail only; not a complete historical log search.'}

    def application(self, resource):
        app_id = self.metadata(resource)['properties']['AppId']
        query = f'''union requests, dependencies, exceptions, traces
| where timestamp between (datetime({self.start.isoformat()}) .. datetime({self.end.isoformat()}))
| extend Error=tostring(column_ifexists("outerMessage", column_ifexists("message", "")))
| summarize events=count(), failures=countif(success == false), p95DurationMs=percentile(duration,95), example=take_any(Error) by itemType, cloud_RoleName, resultCode, type | take 50'''
        url = f'https://api.applicationinsights.io/v1/apps/{app_id}/query?' + urlencode({'query': query})
        rows = table_rows(self.az(['rest', '--method', 'get', '--url', url, '--resource', 'https://api.applicationinsights.io']))
        for row in rows:
            row['example'] = safe_excerpt(row.get('example'))
        return rows

    def metrics(self, resource, database=False):
        definitions = self.az(['monitor', 'metrics', 'list-definitions', '--resource', resource, '--subscription', self.subscription])
        wanted = {'cpu_percent', 'memory_percent', 'storage_percent', 'active_connections', 'connections_failed', 'deadlocks'} if database else {'requests', 'replicas', 'restartcount', 'usagenanocores', 'workingsetbytes', 'responsetime'}
        generic = self.known[resource.lower()]['type'].lower() not in (APP, POSTGRES)
        groups = defaultdict(list)
        for definition in definitions[:6] if generic else definitions:
            name = definition['name']['value']
            if generic or name.lower() in wanted:
                groups[definition.get('primaryAggregationType') or 'Average'].append(name)
        result = []
        for aggregation, names in groups.items():
            metrics = self.az(['monitor', 'metrics', 'list', '--resource', resource, '--subscription', self.subscription, '--metrics', *names, '--aggregation', aggregation, '--start-time', self.start.isoformat(), '--end-time', self.end.isoformat(), '--interval', 'PT5M'])
            result.extend(metric_summary(metrics))
        return result

    def investigate(self, root):
        graph = self.related(root)
        checks = []

        def check(layer, resource, signal, fn, shared=False):
            try:
                data = fn()
                present = bool(data)
                if signal == 'metrics':
                    present = any(m.get('samples', 0) for m in data)
                if isinstance(data, dict) and 'events' in data:
                    present = bool(data['events'])
                checks.append({'layer': layer, 'resource': resource, 'signal': signal, 'status': 'observed' if present else 'no-data', 'shared': shared, 'data': data})
            except Exception:
                checks.append({'layer': layer, 'resource': resource, 'signal': signal, 'status': 'unavailable', 'shared': shared, 'gap': 'This diagnostic could not be retrieved. Do not infer health from missing data.'})

        for item in graph['resources']:
            resource, kind = item['id'], item['type'].lower()
            if resource.lower() == root.lower() and kind not in (APP, INSIGHTS, POSTGRES):
                def metadata(r=resource):
                    data = self.metadata(r)
                    result = {k: data[k] for k in ('id', 'name', 'type', 'location', 'kind', 'sku') if k in data}
                    result['properties'] = {k: v for k, v in data.get('properties', {}).items() if k in ('provisioningState', 'state', 'status', 'runningStatus')}
                    return result
                check('resource', resource, 'metadata', metadata)
                check('resource', resource, 'metrics', lambda r=resource: self.metrics(r))
            if kind == INSIGHTS:
                check('application', resource, 'requests-dependencies-exceptions-traces', lambda r=resource: self.application(r))
            if kind == APP:
                check('container', resource, 'runtime-state', lambda r=resource: {k: v for k, v in self.metadata(r).get('properties', {}).items() if k in ('runningStatus', 'provisioningState', 'latestReadyRevisionName', 'latestRevisionName')})
                check('container', resource, 'metrics', lambda r=resource: self.metrics(r))
                workspaces = [w for w in graph['resources'] if any(link['relationship'] == 'container-log-workspace' and (link['via'] or '').lower() == resource.lower() for link in w['links'])]
                for workspace in workspaces:
                    for table in ('ContainerAppConsoleLogs_CL', 'ContainerAppSystemLogs_CL'):
                        check('container', resource, table, lambda w=workspace['id'], r=resource, table=table: self.logs(w, r, table))
                if not workspaces:
                    graph['gaps'].append({'resource': resource, 'signal': 'container-logs', 'status': 'unresolved', 'reason': 'No accessible log workspace was resolved for this container app.'})
                for log_type, table in [('console', 'ContainerAppConsoleLogs_CL'), ('system', 'ContainerAppSystemLogs_CL')]:
                    if not any(c['resource'] == resource and c['signal'] == table and c['status'] == 'observed' for c in checks):
                        check('container', resource, f'direct-{log_type}-log-tail', lambda r=resource, kind=log_type: self.container_tail(r, kind))
            if kind == POSTGRES:
                check('database', resource, 'metrics', lambda r=resource: self.metrics(r, database=True), item['shared'])
                workspaces = [w for w in graph['resources'] if any(link['relationship'] == 'database-log-workspace' and (link['via'] or '').lower() == resource.lower() for link in w['links'])]
                for workspace in workspaces:
                    for table in ('PostgreSQLFlexServerLogs', 'AzureDiagnostics'):
                        check('database', resource, table, lambda w=workspace['id'], r=resource, table=table: self.logs(w, r, table), item['shared'])
                if not workspaces:
                    graph['gaps'].append({'resource': resource, 'signal': 'database-logs', 'status': 'unresolved', 'reason': 'No accessible database log workspace is configured.'})
        related_ids = {r['id'].lower() for r in graph['resources']}
        def activity():
            events = self.az(['monitor', 'activity-log', 'list', '--resource-group', self.group, '--subscription', self.subscription, '--start-time', self.start.isoformat(), '--end-time', self.end.isoformat(), '--max-events', '100', '--query', '[].{time:eventTimestamp,resource:resourceId,operation:operationName.value,status:status.value,correlationId:correlationId}'])
            return [e for e in events if e.get('resource', '').lower() in related_ids]
        check('deployment', root, 'related-activity (latest 100 group events, filtered)', activity)
        return {**graph, 'windowStart': self.start.isoformat(), 'windowEnd': self.end.isoformat(), 'checks': checks,
                'coverage': {layer: {'observed': sum(c['layer'] == layer and c['status'] == 'observed' for c in checks), 'attempted': sum(c['layer'] == layer for c in checks)} for layer in ('application', 'container', 'database', 'deployment', 'resource')}}
