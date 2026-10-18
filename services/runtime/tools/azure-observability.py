#!/usr/bin/env python3
"""Read-only Azure diagnostics scoped to an explicitly configured resource group."""
import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
import os
import re
import subprocess
import sys
from functools import lru_cache
from azure_workload import Workload, matches_environment


class DiagnosticError(Exception):
    pass


def az(args):
    result = subprocess.run(['az', *args, '--only-show-errors', '--output', 'json'], capture_output=True, text=True, timeout=60)
    if result.returncode:
        # CLI errors can include HTTP payloads or authentication details.
        message = result.stderr.lower()
        if 'az login' in message or 'expired' in message or 'interaction_required' in message:
            raise DiagnosticError('Azure login is missing or expired. Refresh the host login and recreate the runtime.')
        if 'authorizationfailed' in message or 'forbidden' in message or 'autherror' in message:
            raise DiagnosticError('The Azure identity lacks read access for this diagnostic.')
        raise DiagnosticError('Azure could not return this diagnostic. The resource may not support this signal or telemetry may be unavailable.')
    return json.loads(result.stdout or '{}')


def scope():
    subscription = os.environ.get('AZURE_SUBSCRIPTION_ID', '')
    group = os.environ.get('AZURE_RESOURCE_GROUP', '')
    if os.environ.get('TRIAGE_LIVE_AZURE_ENABLED') != 'true':
        raise DiagnosticError('Live Azure diagnostics are disabled.')
    if not re.fullmatch(r'[0-9a-fA-F-]{36}', subscription) or not re.fullmatch(r'[\w.()-]{1,90}', group):
        raise DiagnosticError('Configure AZURE_SUBSCRIPTION_ID and AZURE_RESOURCE_GROUP.')
    return subscription, group


def validate_resource(resource, subscription, group):
    prefix = f'/subscriptions/{subscription}/resourceGroups/{group}/providers/'
    if not resource.lower().startswith(prefix.lower()) or any(c in resource for c in ['?', '#', '%', '\\']) or any(p in ('.', '..', '') for p in resource[1:].split('/')):
        raise DiagnosticError('Resource must belong to the configured subscription and resource group.')
    # Only actual ARM resource IDs are accepted, never appended provider actions.
    tail = resource[len(prefix):].split('/')
    if len(tail) < 3 or len(tail) % 2 != 1 or any(p.lower() == 'providers' for p in tail[1:]):
        raise DiagnosticError('Invalid ARM resource ID.')
    return resource


def safe_metadata(data):
    result = {k: data[k] for k in ('id', 'name', 'type', 'location', 'kind', 'sku') if k in data}
    properties = data.get('properties') or {}
    allowed = ('provisioningState', 'state', 'status', 'runningStatus', 'latestRevisionName', 'latestReadyRevisionName', 'kubernetesVersion', 'currentKubernetesVersion', 'version', 'publicNetworkAccess', 'availabilityZone', 'replicaRole')
    result['properties'] = {k: properties[k] for k in allowed if k in properties}
    return result


@lru_cache(maxsize=1)
def resources(subscription, group):
    return az(['resource', 'list', '--subscription', subscription, '--resource-group', group,
               '--query', '[].{id:id,name:name,type:type,location:location,kind:kind}'])


def run(args):
    subscription, group = scope()
    common = ['--subscription', subscription]
    now = datetime.now(timezone.utc)
    start = (now - timedelta(hours=args.hours)).isoformat()
    environment = getattr(args, 'environment', 'all')
    context = {'mode': 'live-azure', 'subscriptionId': subscription, 'resourceGroup': group, 'environment': environment, 'checkedAt': now.isoformat()}
    if args.command == 'inventory':
        account = az(['account', 'show', *common, '--query', '{id:id,name:name,state:state}'])
        rg = az(['group', 'show', '--name', group, *common, '--query', '{id:id,name:name,location:location}'])
        items = [r for r in resources(subscription, group) if matches_environment(r['name'], environment)]
        return {**context, 'connected': True, 'subscription': account['name'], 'location': rg['location'], 'resources': items, 'resourceCount': len(items), 'resourceTypes': dict(sorted(Counter(r['type'].lower() for r in items).items()))}
    if args.command == 'activity':
        events = az(['monitor', 'activity-log', 'list', '--resource-group', group, *common, '--start-time', start, '--end-time', now.isoformat(), '--max-events', '100', '--query', '[].{time:eventTimestamp,resource:resourceId,operation:operationName.value,status:status.value,level:level,correlationId:correlationId}'])
        allowed = {r['id'].lower() for r in resources(subscription, group) if matches_environment(r['name'], environment)}
        events = [e for e in events if e.get('resource', '').lower() in allowed]
        return {**context, 'windowStart': start, 'events': events, 'limit': 100}
    resource = validate_resource(args.resource or '', subscription, group)
    # Membership check rejects a synthetic child/action endpoint such as listKeys.
    known = {r['id'].lower(): r for r in resources(subscription, group)}
    if resource.lower() not in known:
        raise DiagnosticError('Resource was not found in the configured resource-group inventory.')
    kind = known[resource.lower()]['type'].lower()
    workload = Workload(az, list(known.values()), subscription, group, environment, args.hours)
    if not matches_environment(known[resource.lower()]['name'], environment):
        related_to = getattr(args, 'related_to', None)
        if not related_to or related_to.lower() not in known or not matches_environment(known[related_to.lower()]['name'], environment):
            raise DiagnosticError('Resource name does not match the selected environment. Shared dependencies require --related-to with a matching app resource.')
        related = workload.related(related_to)
        if resource.lower() not in {r['id'].lower() for r in related['resources']}:
            raise DiagnosticError('Resource is not a resolved dependency of the selected environment.')
    data = None
    if args.command == 'related':
        data = workload.related(resource)
    elif args.command == 'workload-check':
        data = workload.investigate(resource)
    elif args.command == 'resource':
        data = safe_metadata(az(['resource', 'show', '--ids', resource, *common]))
    elif args.command == 'health':
        data = az(['rest', '--method', 'get', '--url', f'https://management.azure.com{resource}/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=2022-10-01', '--query', '{state:properties.availabilityState,reason:properties.reasonType,occurredTime:properties.occurredTime,reportedTime:properties.reportedTime}'])
    elif args.command == 'metric-definitions':
        data = az(['monitor', 'metrics', 'list-definitions', '--resource', resource, *common, '--query', '[].{name:name.value,unit:unit,aggregation:primaryAggregationType,supportedAggregations:supportedAggregationTypes}'])
    elif args.command == 'metrics':
        if not args.metric or not re.fullmatch(r'[\w .()/%-]{1,150}', args.metric):
            raise DiagnosticError('Provide one metric name from metric-definitions.')
        data = az(['monitor', 'metrics', 'list', '--resource', resource, *common, '--metric', args.metric, '--aggregation', args.aggregation, '--start-time', start, '--end-time', now.isoformat(), '--interval', 'PT5M'])
    elif args.command in ('logs', 'log-tables'):
        if kind != 'microsoft.operationalinsights/workspaces':
            raise DiagnosticError('Select a Log Analytics workspace from inventory.')
        workspace = az(['resource', 'show', '--ids', resource, *common, '--query', 'properties.customerId'])
        if environment != 'all':
            # Shared workspaces must be queried for a verified related resource,
            # never enumerated or searched across other environments.
            related_to = getattr(args, 'related_to', None)
            if args.command != 'logs' or not related_to:
                raise DiagnosticError('Use workload-check or logs --related-to for environment-scoped workspace queries.')
            data = workload.logs(resource, related_to, args.table)
            return {**context, 'resource': resource, 'diagnostic': args.command, 'windowStart': start, 'data': data}
        if args.command == 'log-tables':
            query = f'search * | where TimeGenerated > ago({args.hours}h) | summarize events=count() by $table | top 100 by events'
        else:
            if not args.table or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,100}', args.table):
                raise DiagnosticError('Provide a table name from log-tables.')
            if not re.fullmatch(r'[\w .-]{0,120}', args.filter):
                raise DiagnosticError('The resource filter may contain letters, digits, spaces, dots, underscores, or hyphens.')
            query = f'''{args.table} | where TimeGenerated > ago({args.hours}h)
| extend Resource=tostring(column_ifexists("ContainerAppName_s", column_ifexists("AppRoleName", column_ifexists("_ResourceId", "")))), Severity=tostring(column_ifexists("Level", column_ifexists("LogLevel_s", ""))), Result=tostring(column_ifexists("ResultCode", "")), Exception=tostring(column_ifexists("ExceptionType", ""))
| where Resource contains "{args.filter}"
| summarize events=count() by bin(TimeGenerated, 5m), Resource, Severity, Result, Exception | top 100 by TimeGenerated desc'''
        data = az(['monitor', 'log-analytics', 'query', '--workspace', workspace, '--analytics-query', query, '--timespan', f'PT{args.hours}H', *common])
    elif args.command == 'app-insights':
        if kind != 'microsoft.insights/components':
            raise DiagnosticError('Select an Application Insights component from inventory.')
        data = workload.application(resource)
    return {**context, 'resource': resource, 'diagnostic': args.command, 'windowStart': start, 'data': data}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['inventory', 'related', 'workload-check', 'resource', 'health', 'metric-definitions', 'metrics', 'activity', 'log-tables', 'logs', 'app-insights'])
    parser.add_argument('--resource')
    parser.add_argument('--metric')
    parser.add_argument('--aggregation', choices=['Average', 'Minimum', 'Maximum', 'Total', 'Count'], default='Average')
    parser.add_argument('--hours', type=int, choices=range(1, 25), default=1)
    parser.add_argument('--table')
    parser.add_argument('--filter', default='')
    parser.add_argument('--environment', choices=['all', 'staging', 'production'], default='all')
    parser.add_argument('--related-to')
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except (DiagnosticError, subprocess.TimeoutExpired, ValueError) as error:
        message = str(error) if isinstance(error, DiagnosticError) else 'Azure diagnostic timed out.' if isinstance(error, subprocess.TimeoutExpired) else 'Diagnostic request did not match the environment or a supported resource relationship.'
        print(json.dumps({'mode': 'live-azure', 'error': message}))
        sys.exit(1)


if __name__ == '__main__':
    main()
