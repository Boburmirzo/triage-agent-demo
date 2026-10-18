#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timezone


def build_payload(incident: str) -> dict:
    text = incident or "ExampleCo staging report failed with timeout around 10:00 UTC"
    lowered = text.lower()
    environment = "production" if "prod" in lowered else "staging"
    customer = "ExampleCo" if "exampleco" in lowered else "Demo Customer"

    return {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "mode": "offline-demo-simulation",
        "incident": {
            "customer": customer,
            "environment": environment,
            "workflow": "Report generation",
            "reported_symptom": text,
            "assumed_window_utc": "2026-08-12T09:55:00Z/2026-08-12T10:10:00Z",
        },
        "timeline": [
            {
                "timestamp_utc": "2026-08-12T09:58:14Z",
                "source": "Application Insights requests",
                "observation": "POST /api/reports/generate starts returning 500 and timeout responses.",
            },
            {
                "timestamp_utc": "2026-08-12T10:00:31Z",
                "source": "Application Insights exceptions",
                "observation": "TimeoutError recorded by ReportRenderService for operation demo-op-7f3a.",
            },
            {
                "timestamp_utc": "2026-08-12T10:01:08Z",
                "source": "Azure dependencies",
                "observation": "PostgreSQL p95 latency reaches 8.4 seconds during report query phase.",
            },
            {
                "timestamp_utc": "2026-08-12T10:02:44Z",
                "source": "Container Apps",
                "observation": "Worker app records two restarts after memory pressure.",
            },
            {
                "timestamp_utc": "2026-08-12T10:04:12Z",
                "source": "Queue Storage",
                "observation": "Report generation queue depth reaches 187 messages; oldest message age is 18 minutes.",
            },
        ],
        "evidence": [
            {
                "source": "Application Insights requests",
                "resource": "sample-backend-api-staging",
                "finding": "12 failed report-generation requests in the incident window.",
                "correlation_id": "demo-op-7f3a",
            },
            {
                "source": "Application Insights exceptions",
                "resource": "sample-backend-api-staging",
                "finding": "TimeoutError raised by ReportRenderService after dependency calls exceeded 30 seconds.",
                "correlation_id": "demo-op-7f3a",
            },
            {
                "source": "Dependencies",
                "resource": "postgresql://demo-postgres/reporting",
                "finding": "PostgreSQL p95 dependency latency rose from 120 ms to 8.4 s.",
                "correlation_id": "demo-op-7f3a",
            },
            {
                "source": "Container Apps",
                "resource": "sample-functions-staging",
                "finding": "Worker app restarted twice and had memory pressure during queue processing.",
                "correlation_id": "demo-worker-revision-42",
            },
            {
                "source": "Queue Storage",
                "resource": "report-generation",
                "finding": "Queue depth increased to 187 messages and oldest visible message age reached 18 minutes.",
                "correlation_id": "demo-queue-report-generation",
            },
            {
                "source": "Deployment metadata",
                "resource": "sample-functions-staging revisions",
                "finding": "No new revision was activated between 09:30 and 10:15 UTC.",
                "correlation_id": "demo-worker-revision-42",
            },
        ],
        "correlation": {
            "most_likely_root_cause": "Report generation timed out because PostgreSQL dependency latency spiked while the worker app was under memory pressure. Queue backlog amplified the delay.",
            "less_likely_causes": [
                "Deployment regression is less likely because no new revision was activated during the incident window.",
                "Authentication failure is less likely because failures happened after report-generation requests started processing.",
            ],
            "severity": "High",
            "confidence": "Medium-high",
        },
        "recommended_actions": [
            "Check PostgreSQL slow query and connection metrics for 09:55-10:10 UTC.",
            "Inspect report worker memory usage and tune memory or concurrency limits.",
            "Drain or replay queued jobs after worker health stabilizes.",
            "Add alerts for report queue age above 5 minutes and PostgreSQL p95 latency above 2 seconds.",
            "Attach operation ID demo-op-7f3a to the incident handoff.",
        ],
        "production_mapping": {
            "requests_and_exceptions": "Azure Application Insights KQL over requests and exceptions tables.",
            "dependencies": "Application Insights dependencies table and Azure Monitor database metrics.",
            "container_health": "Azure Container Apps revisions, replicas, logs, and metrics.",
            "queue_depth": "Azure Storage Queue or Service Bus metadata and metrics.",
            "deployment_metadata": "Container App revision history, image tags, Git SHA metadata, or release records.",
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Return seeded Azure observability evidence for the triage-agent demo.")
    parser.add_argument("--incident", default="", help="Short incident description for demo context.")
    args = parser.parse_args()
    print(json.dumps(build_payload(args.incident), indent=2))


if __name__ == "__main__":
    main()
