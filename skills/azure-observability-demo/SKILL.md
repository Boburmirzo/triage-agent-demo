# Azure Observability Demo Skill

Use this skill when demonstrating Azure incident triage with either seeded offline evidence or optional live read-only Azure diagnostics.

## Purpose

This skill helps the demo `triage-agent` explain the triage workflow and choose the correct evidence path:

- Offline demo mode uses `tools/demo-observability.py`.
- Live Azure mode uses read-only Azure CLI commands after `az account show` succeeds.

## Rules

- Always say when evidence is simulated demo evidence.
- Do not claim that Azure Monitor, Application Insights, Log Analytics, Container Apps, queues, or databases were queried live unless the relevant `az` command succeeded in this session.
- Do not ask for Azure credentials.
- Do not run commands outside the allowlist.
- Do not suggest destructive remediation as an agent action.
- Do not run `az` write operations, restarts, scale changes, deployments, queue deletes, key vault secret reads, or SQL writes.

## Offline Demo Tool

Run:

```bash
python3 /workspace/tools/demo-observability.py --incident "Centralis staging report failed with timeout around 10:00 UTC"
```

The tool returns JSON with these sections:

- `incident`
- `timeline`
- `evidence`
- `correlation`
- `recommended_actions`
- `production_mapping`

## Live Azure Mode

If the user asks to run against their Azure account, first run:

```bash
az account show
```

If it succeeds, continue with read-only discovery and diagnostics:

```bash
az group list
az resource list
az graph query -q "Resources | summarize count() by type | order by count_ desc"
az monitor log-analytics workspace list
az containerapp list
az functionapp list
az storage account list
az sql server list
```

Use resource-group filters when the user provides a target scope. Keep all queries bounded and compact.

Example KQL shape for Application Insights:

```kusto
exceptions
| where timestamp > ago(1h)
| project timestamp, type, outerMessage, operation_Name, operation_Id, cloud_RoleName
| take 50
```

## Correlation Strategy

Use these signals in order:

1. Request failure count and time window.
2. Exception type and operation ID.
3. Dependency latency and failed target.
4. Worker health and restart signal.
5. Queue depth and oldest message age.
6. Deployment metadata to accept or reduce release-regression likelihood.

## RCA Guidance

For the seeded incident, the strongest explanation is:

```text
Report generation timed out because PostgreSQL dependency latency spiked while the worker app was under memory pressure. Queue backlog amplified the delay. No revision was activated in the incident window, so deployment regression is less likely.
```

Keep the final response concise and evidence-backed.
