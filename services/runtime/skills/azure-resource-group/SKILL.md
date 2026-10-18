---
name: azure-resource-group
description: Investigate the configured real Azure resource group using scoped read-only inventory, resource metadata, resource health, metrics, activity history, and telemetry queries across every discovered resource type.
---

# Live Azure resource-group investigation

Use this skill only when the user's current request needs real resource data
or diagnostics. Having a connected resource group does not mean the caller has
requested an investigation. Greetings, general explanations, capability questions,
and explanations of existing findings should be answered directly without tools.
For an actual diagnostic request, this guidance selects the live evidence path
in the original triage instructions. Never use seeded ExampleCo evidence here.

Use `python3 /workspace/tools/azure-observability.py` for Azure diagnostics.
It fixes the configured subscription/resource group and rejects resources outside
that group. Raw `az` commands are disabled in scoped mode. Its `inventory` command
verifies the Azure account and resource group, replacing direct `az account show`.

## Environment and correlated workload checks

The runtime tells you the selected environment for each turn. Pass
`--environment staging`, `--environment production`, or `--environment all` to
every helper command. Staging discovery includes names containing `staging`;
production includes names containing `prod`, both case-insensitively. The selector
is not just a label. Do not silently broaden to another environment.

For a backend/application investigation, start with `workload-check` after
identifying the resource. It follows a selected App Insights component to a
same-name/environment Container App candidate, resolves the app's actual managed
environment and log workspace, and follows visible database-host references or
operator-confirmed environment database mappings. A name match is a candidate
relationship, not proof that telemetry is correctly wired.

```sh
python3 /workspace/tools/azure-observability.py inventory --environment staging
python3 /workspace/tools/azure-observability.py related --environment staging --resource "STAGING_RESOURCE_ID"
python3 /workspace/tools/azure-observability.py workload-check --environment staging --resource "STAGING_RESOURCE_ID" --hours 1
```

Allow up to 240 seconds for the workload-check bash call: it collects multiple
bounded diagnostics. Its checks cover:
- App Insights requests, dependencies, exceptions **and traces**.
- Container App runtime state, restarts/replicas/resource metrics, and timestamped
  console **and system** log excerpts from the linked Log Analytics workspace.
- Resolved PostgreSQL CPU, memory, storage, connections/failures and database log
  aggregates from configured diagnostic destinations.
- Related deployment/control-plane activity in the same time window.

**Do not stop at an empty App Insights component.** Continue through the host and
its actual log workspace. Report cross-layer correlations and specific failures,
with timestamps and resource IDs. If logs are empty or unavailable, say which
tables/destinations were checked. Shared-server database metrics are not
staging-only; label them explicitly. SQL text, database row data, credentials,
and request payloads must never appear in the answer. Log excerpts are redacted.

For an independent query on a shared workspace/database, include
`--related-to "STAGING_RESOURCE_ID"`. The helper verifies the relationship.
Do not assume all databases in the resource group serve the selected workload.
An unresolved relationship is a gap; ask for a non-secret mapping rather than
reading secret connection strings. For a deliberately narrow inventory-only or
metric-only question, respect that scope instead of running a full workload check.

1. Run `inventory` when resource discovery is needed. It covers **every resource
   type**, including nested resources. Investigate only what the user requested;
   discovering the group is not a request to diagnose every resource in it.
2. Select relevant resource IDs from that inventory. Use `resource` for safe
   provisioning/configuration metadata and `health` for Azure Resource Health.
3. Run `metric-definitions` before choosing metric names; metric availability
   differs across resource types. Use `metrics` to query a bounded window.
4. Use `activity` to correlate failures with recent control-plane changes.
5. For Log Analytics workspaces, use `log-tables` then `logs` for bounded,
   aggregate telemetry. Use `--filter` to narrow the service name.
6. For Application Insights components, use `app-insights` to query request,
   dependency, and exception aggregates. No instrumentation keys are needed.

```sh
python3 /workspace/tools/azure-observability.py inventory
python3 /workspace/tools/azure-observability.py activity --hours 1
python3 /workspace/tools/azure-observability.py resource --resource "RESOURCE_ID"
python3 /workspace/tools/azure-observability.py health --resource "RESOURCE_ID"
python3 /workspace/tools/azure-observability.py metric-definitions --resource "RESOURCE_ID"
python3 /workspace/tools/azure-observability.py metrics --resource "RESOURCE_ID" --metric "METRIC_NAME" --aggregation Average --hours 1
python3 /workspace/tools/azure-observability.py log-tables --resource "WORKSPACE_RESOURCE_ID" --hours 1
python3 /workspace/tools/azure-observability.py logs --resource "WORKSPACE_RESOURCE_ID" --table ContainerAppConsoleLogs_CL --filter "example-backend-prod" --hours 1
python3 /workspace/tools/azure-observability.py app-insights --resource "APP_INSIGHTS_RESOURCE_ID" --hours 1
```

`resource` supports all ARM resource types, including AKS, VMs, networks,
PostgreSQL, Service Bus, Redis, AI accounts, Key Vault, Data Factory, and alerts.
Some resources have no metrics or Resource Health endpoint; report that as a
coverage gap, not healthy status. ARM inspection does not imply Kubernetes
pod access, SQL access, secret access, or access to storage/message contents.

Resource discovery is not a health assessment. State which resources and signals
were actually checked, the UTC time window, evidence, and remaining gaps. Do not
call every resource unhealthy or healthy from provisioning state alone. For a
group-wide overview, report inventory by type, activity failures, and monitoring
coverage before choosing targeted diagnostics. Do not issue one request per
resource unnecessarily. Never perform remediation or request keys/credentials.
