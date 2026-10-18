import importlib.util
import os
import sys
from pathlib import Path
import unittest
from types import SimpleNamespace
from datetime import timedelta
from unittest.mock import patch

tools = Path(__file__).resolve().parents[1] / 'services/runtime/tools'
sys.path.insert(0, str(tools))
from azure_workload import Workload, matches_environment, safe_excerpt, metric_summary
spec = importlib.util.spec_from_file_location('diagnostics', tools / 'azure-observability.py')
diagnostics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostics)
SUB = '00000000-0000-0000-0000-000000000001'
GROUP = 'example-observability'
PREFIX = f'/subscriptions/{SUB}/resourceGroups/{GROUP}/providers/'


class AzureDiagnosticsTests(unittest.TestCase):
    def test_environment_names_are_case_insensitive_and_shared_is_not_a_name_match(self):
        self.assertTrue(matches_environment('EXAMPLE-STAGING', 'staging'))
        self.assertFalse(matches_environment('example-backend-prod', 'staging'))
        self.assertTrue(matches_environment('exampleprod', 'production'))
        self.assertFalse(matches_environment('example-read-replica', 'staging'))
        self.assertTrue(matches_environment('example-read-replica', 'all'))

    def test_log_samples_redact_payloads_sql_credentials_and_signed_urls(self):
        for text in ['password=private-value', 'Bearer private-value', 'SELECT email FROM customers', 'headers: private-value', 'payload: private-value']:
            self.assertNotIn('private-value', safe_excerpt(text))
            self.assertIn('omitted', safe_excerpt(text))
        self.assertNotIn('private-value', safe_excerpt('https://example.org/test?value=private-value'))
        self.assertNotIn('private-value', safe_excerpt('postgres://user:private-value@host/db'))
        self.assertEqual(safe_excerpt('{"level":"error","message":"Worker timed out"}'), 'Worker timed out')

    def test_metrics_distinguish_no_samples_and_zero_samples(self):
        result = metric_summary({'value': [{'name': {'value': 'Requests'}, 'timeseries': [{'data': [{'total': 0}, {'total': 0}]}]}, {'name': {'value': 'Latency'}, 'timeseries': [{'data': [{'average': None}]}]}]})
        self.assertEqual(result[0]['samples'], 2)
        self.assertEqual(result[0]['total'], 0)
        self.assertEqual(result[1]['samples'], 0)
        self.assertIsNone(result[1]['meanOfBuckets'])

    def test_empty_app_insights_continues_to_container_and_database_checks(self):
        def resource(kind, name):
            return {'id': PREFIX + kind + '/' + name, 'type': kind, 'name': name, 'links': [], 'shared': kind.endswith('flexibleServers')}
        items = [resource('Microsoft.Insights/components', 'backend-api-staging'), resource('Microsoft.App/containerApps', 'backend-staging'), resource('Microsoft.DBforPostgreSQL/flexibleServers', 'shared-replica')]
        resolver = Workload(lambda args: [], items, SUB, GROUP, 'staging')
        with patch.object(resolver, 'related', return_value={'resources': items, 'gaps': []}), patch.object(resolver, 'application', return_value=[]), patch.object(resolver, 'metadata', return_value={'properties': {'runningStatus': 'Running'}}), patch.object(resolver, 'metrics', return_value=[{'metric': 'cpu_percent', 'samples': 12, 'max': 4}]), patch.object(resolver, 'container_tail', return_value={'events': [{'Message': 'Worker timed out'}]}) as tail:
            result = resolver.investigate(items[0]['id'])
        self.assertEqual(result['coverage']['application']['observed'], 0)
        self.assertGreater(result['coverage']['container']['observed'], 0)
        self.assertGreater(result['coverage']['database']['observed'], 0)
        self.assertEqual(tail.call_count, 2)

    def test_direct_log_tail_is_bounded_redacted_and_time_filtered(self):
        app = {'id': PREFIX + 'Microsoft.App/containerApps/backend-staging', 'type': 'Microsoft.App/containerApps', 'name': 'backend-staging'}
        resolver = Workload(lambda args: {}, [app], SUB, GROUP, 'staging')
        import json
        output = '\n'.join(json.dumps(event) for event in [
            {'TimeStamp': (resolver.end - timedelta(minutes=5)).isoformat(), 'Log': 'Worker timed out'},
            {'TimeStamp': (resolver.end - timedelta(minutes=6)).isoformat(), 'Log': 'password=private-value'},
            {'TimeStamp': (resolver.start - timedelta(minutes=1)).isoformat(), 'Log': 'old event'},
        ])
        with patch('azure_workload.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=output)) as run:
            result = resolver.container_tail(app['id'], 'system')
        self.assertEqual(len(result['events']), 2)
        self.assertEqual(result['excludedOutsideWindow'], 1)
        self.assertNotIn('private-value', str(result))
        command = run.call_args.args[0]
        self.assertEqual(command[command.index('--follow') + 1], 'false')
        self.assertEqual(command[command.index('--tail') + 1], '50')

    def test_relationships_follow_staging_host_and_confirmed_shared_replica_only(self):
        def item(kind, name):
            return {'id': PREFIX + kind + '/' + name, 'name': name, 'type': kind}
        insights = item('Microsoft.Insights/components', 'example-backend-api-staging')
        app = item('Microsoft.App/containerApps', 'example-backend-staging')
        prod = item('Microsoft.App/containerApps', 'example-backend-prod')
        environment = item('Microsoft.App/managedEnvironments', 'shared-env')
        workspace = item('Microsoft.OperationalInsights/workspaces', 'shared-logs')
        db = item('Microsoft.DBforPostgreSQL/flexibleServers', 'example-read-replica')
        unrelated = item('Microsoft.DBforPostgreSQL/flexibleServers', 'pulse-db')
        items = [insights, app, prod, environment, workspace, db, unrelated]
        def az(args):
            if args[:3] == ['monitor', 'diagnostic-settings', 'list']:
                return [{'workspaceId': workspace['id']}]
            resource = args[args.index('--ids') + 1]
            props = {app['id']: {'managedEnvironmentId': environment['id'], 'template': {'containers': [{'env': [{'secretRef': 'private-value'}]}]}}, environment['id']: {'appLogsConfiguration': {'logAnalyticsConfiguration': {'customerId': 'workspace-id'}}}, workspace['id']: {'customerId': 'workspace-id'}}
            return {'properties': props.get(resource, {})}
        with patch.dict(os.environ, {'AZURE_STAGING_DATABASE_SERVERS': db['name']}):
            resolver = Workload(az, items, SUB, GROUP, 'staging')
            graph = resolver.related(insights['id'])
            ids = {r['id'] for r in graph['resources']}
            self.assertIn(app['id'], ids)
            self.assertIn(db['id'], ids)
            self.assertIn(workspace['id'], ids)
            self.assertNotIn(prod['id'], ids)
            self.assertNotIn(unrelated['id'], ids)
            self.assertNotIn('private-value', str(graph))
            shared = next(r for r in graph['resources'] if r['id'] == workspace['id'])
            self.assertTrue(shared['shared'])
            self.assertEqual(len(shared['links']), 2)
            with self.assertRaises(ValueError):
                resolver.related(prod['id'])

    def test_all_arm_resource_types_and_nested_resources(self):
        for suffix in ['Microsoft.App/containerApps/app', 'Microsoft.DBforPostgreSQL/flexibleServers/db', 'Microsoft.ContainerService/managedClusters/aks', 'Microsoft.Compute/virtualMachines/vm/extensions/extension', 'Microsoft.CognitiveServices/accounts/account/projects/project']:
            resource = PREFIX + suffix
            self.assertEqual(diagnostics.validate_resource(resource, SUB, GROUP), resource)

    def test_scope_and_action_escape_rejected(self):
        for resource in [PREFIX.replace(GROUP, 'other-group') + 'Microsoft.Storage/storageAccounts/account', PREFIX + 'Microsoft.Storage/storageAccounts/account/listKeys', PREFIX + 'Microsoft.Storage/storageAccounts/account?api-version=x', PREFIX + 'Microsoft.Storage/storageAccounts/account/../other', PREFIX + 'Microsoft.Storage/storageAccounts/account%2flistKeys', PREFIX + 'Microsoft.Storage/storageAccounts/account/providers/Microsoft.Authorization/roleAssignments/id']:
            with self.assertRaises(diagnostics.DiagnosticError):
                diagnostics.validate_resource(resource, SUB, GROUP)

    def test_live_mode_required(self):
        with patch.dict(os.environ, {'AZURE_SUBSCRIPTION_ID': SUB, 'AZURE_RESOURCE_GROUP': GROUP, 'TRIAGE_LIVE_AZURE_ENABLED': 'false'}):
            with self.assertRaises(diagnostics.DiagnosticError):
                diagnostics.scope()

    def test_metadata_excludes_app_settings_keys_and_sensitive_properties(self):
        data = {'id': 'id', 'name': 'app', 'type': 'Microsoft.App/containerApps', 'properties': {'provisioningState': 'Succeeded', 'configuration': {'secrets': [{'value': 'do-not-return'}]}, 'template': {'containers': [{'env': [{'value': 'do-not-return'}]}]}, 'connectionString': 'do-not-return', 'administratorLogin': 'do-not-return'}}
        safe = diagnostics.safe_metadata(data)
        self.assertEqual(safe['properties'], {'provisioningState': 'Succeeded'})
        self.assertNotIn('do-not-return', str(safe))

    def test_provider_auth_error_is_an_access_gap_not_a_health_result(self):
        with patch.object(diagnostics.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout='', stderr='{"code":"AuthError","message":"private-details"}')):
            with self.assertRaisesRegex(diagnostics.DiagnosticError, 'lacks read access'):
                diagnostics.az(['rest', '--method', 'get'])


if __name__ == '__main__':
    unittest.main()
