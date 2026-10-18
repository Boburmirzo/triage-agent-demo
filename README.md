# Signal · Agentic Azure Observability

A streaming, evidence-first workspace for investigating Azure incidents. Chat
with an observability agent, watch diagnostic activity, and follow findings from
application telemetry through container health and database signals.

## Quick start

Requires Docker with the Docker Compose plugin.

```bash
git clone https://github.com/Boburmirzo/triage-agent-demo.git
cd triage-agent-demo
docker compose up --build -d --wait
```

Open **http://localhost:7070**. The default demo needs no cloud credentials,
model API key, or database. Choose an example prompt and press **Send**.

| Service | Address | Responsibility |
| --- | --- | --- |
| UI | http://localhost:7070 | Chat, resource search, activity trace, evidence, Markdown export |
| API | http://localhost:7071 | Persistent conversations, run lifecycle, server-sent events |
| Runtime | Internal `http://runtime:4096` | Seeded diagnostics or the OpenCode agent |

Change host ports with `UI_PORT` and `API_PORT`. Conversation state lives in
`api-data`; OpenCode sessions live in `runtime-data`.

```bash
docker compose ps
curl http://localhost:7071/health
docker compose down
```

Stopping the stack preserves named volumes.

## Features

- Streaming Markdown chat with visible diagnostic tool activity.
- Ordinary conversation for greetings and general questions in OpenCode mode.
- Searchable live Azure resource inventory and environment selection.
- Correlated application, container, database, and deployment diagnostics.
- Clear distinctions between observed evidence, missing telemetry, and inferred causes.
- Cancellation, reconnect/reload recovery, persistent history, and Markdown export.
- Deterministic, credential-free demo mode for presentations and experimentation.

## Architecture

```text
Browser → UI / nginx :8080 → API :8088 → Runtime :4096
                              │             ├─ demo: seeded evidence + streamed answer
                              │             └─ OpenCode :4097 → LiteLLM → model
                              └─ api-data                 └─ runtime-data

                      ← SSE messages, tool activity, and state updates ←
```

```text
services/
  api/                 # Conversation persistence and run orchestration
  runtime/
    agents/            # Triage instructions
    config/            # Provider configuration and tool permissions
    skills/            # Demo and live Azure investigation guidance
    tools/             # Seeded evidence and scoped Azure diagnostic helpers
    lib/               # Shared JSON/SSE transport utilities
  ui/
    public/            # Dependency-free browser UI
    nginx.conf         # Same-origin API proxy with SSE buffering disabled
tests/                 # Transport, configuration, environment, and diagnostic tests
docker-compose.yml
.env.example
```

Each browser stream starts with an authoritative snapshot and then receives
message deltas, tool updates, and session updates. The API owns execution
independently of the browser, so closing a tab does not cancel a run. **Stop**
cancels the runtime request and the corresponding OpenCode session. An API
restart marks in-flight responses interrupted; completed conversations persist.

## Use a model through LiteLLM

Copy `.env.example` to `.env` and configure your gateway:

```dotenv
TRIAGE_MODE=opencode
LITELLM_BASE_URL=http://host.docker.internal:4000/v1
OPENAI_API_KEY=your-gateway-key
OPENCODE_MODEL=your-deployed-model-alias
OPENCODE_SMALL_MODEL=your-deployed-model-alias
OPENCODE_MODEL_DISPLAY_NAME=Your model
```

```bash
docker compose up --build -d --wait
```

The gateway must support the **OpenAI Responses API**, streaming, and tool
calling. LiteLLM is an external endpoint, not a fourth required container.
`host.docker.internal` reaches a host gateway from Docker Desktop; the Compose
file also provides a Linux host-gateway mapping. The gateway must listen on a
container-reachable interface.

`OPENAI_API_KEY` takes precedence over the optional `LITELLM_API_KEY` fallback.
Choose aliases and limits that match your deployed model:

| Variable | Default |
| --- | --- |
| `OPENCODE_PROVIDER_ID` / `OPENCODE_PROVIDER_NAME` | `litellm` / `LiteLLM` |
| `OPENCODE_MODEL` / `OPENCODE_SMALL_MODEL` | `gpt-6-sol` |
| `OPENCODE_MODEL_CONTEXT_LIMIT` | `1050000` |
| `OPENCODE_MODEL_INPUT_LIMIT` | `922000` |
| `OPENCODE_MODEL_OUTPUT_LIMIT` | `16000` |
| `OPENCODE_COMPACTION_RESERVED` | `50000` |
| `TRIAGE_RUN_TIMEOUT_MS` | `600000` |

The runtime packages OpenCode `1.18.30` with the `@ai-sdk/openai` provider.
Its native server listens on runtime loopback (`4097`). Provider credentials
are never sent to the browser. Recreate the runtime after environment changes;
rebuild it after changing packaged agent instructions, skills, or configuration.

## Connect a real Azure resource group

Set these additional values in `.env`:

```dotenv
TRIAGE_MODE=opencode
TRIAGE_LIVE_AZURE_ENABLED=true
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_RESOURCE_GROUP=example-observability
```

Start the stack, then authenticate the runtime:

```bash
docker compose up -d --wait
docker compose exec runtime az login --use-device-code
```

The scoped helper explicitly selects the configured subscription and resource
group for every diagnostic. The identity needs read access to the relevant
resources and telemetry, such as Reader, Monitoring Reader, and Log Analytics
Reader. CLI login state in the container must be renewed after recreation unless
you supply an Azure CLI configuration volume.

On supported Azure hosts, use `AZURE_LOGIN_WITH_MANAGED_IDENTITY=true`, optionally
`AZURE_CLIENT_ID`, and the same subscription/resource-group configuration instead.

Once connected, the UI displays real inventory counts and a **Resources** tab.
Select a resource to prepare a workload investigation. Greetings and general
questions receive normal answers; diagnostic tools run when current evidence is
requested. The Resources tab refreshes inventory independently of chat.

### Environment selection

- **Staging:** names containing `staging`, case-insensitively.
- **Production:** names containing `prod`, case-insensitively.
- **All resources:** the entire configured resource group.

Selection applies to resource search, counts, example prompts, and each chat
turn. Change it between messages to switch scope.

Shared resources are resolved through resource references or explicit mappings,
not assumed to belong exclusively to an environment. When an app's connection
details are secret references, configure confirmed PostgreSQL resource names:

```dotenv
AZURE_STAGING_DATABASE_SERVERS=example-read-replica
AZURE_PRODUCTION_DATABASE_SERVERS=example-primary-db
```

These optional mappings accept comma-separated names. Shared database metrics
are labelled server-wide rather than environment-specific.

### Diagnostic coverage

Application investigations use a correlated workload check:

1. Application Insights requests, dependencies, exceptions, and traces.
2. Related Container App state, replicas, restarts, and resource metrics.
3. Console/system logs from the app's linked Log Analytics workspace.
4. A bounded, non-following direct log tail when workspace logs are empty.
5. Resolved PostgreSQL CPU, memory, storage, connections, and diagnostic log destinations.
6. Related deployment/control-plane activity within the same UTC window.

An empty Application Insights component does not end the investigation. The
agent follows the host and available downstream signals, distinguishing name-based
candidate relationships from confirmed references. Missing exports, unavailable
signals, or inaccessible resources are reported as coverage gaps, not proof of health.

Generic metadata and available metric discovery also cover other ARM resource
types in the group. These diagnostics do not grant SQL access, Kubernetes pod
access, or access to Key Vault secrets, blob contents, or message payloads.
Log excerpts are redacted; SQL statements and request payloads are omitted.
The agent performs no remediation or resource modifications.

## Tests

Requires Node.js 22+ and Python 3. No npm dependencies are required.

```bash
npm test
npm run test:azure
```

Tests cover streaming transport, reconnection, persistence, cancellation,
conversational behavior, model configuration, environment scope, resource
relationships, log redaction, and continued checks after empty telemetry.

To exercise the packaged OpenCode binary against a deterministic mock Responses
API without model credentials:

```bash
docker compose build runtime
npm run test:opencode
```

This check creates and removes its own temporary runtime container. It verifies
skill loading, a seeded diagnostic tool invocation, and streamed text.

## Scope

This is a single-user demonstration workspace. The API uses a single-process
JSON store rather than shared multi-replica storage or tenant authentication.
Published host ports bind to loopback. Conversations are capped at 100 turns;
messages are limited to 16,000 characters.

Demo mode always replays a fixed incident and clearly labels simulated evidence.
OpenCode mode provides conversational analysis; live Azure results depend on
the permissions and telemetry available in the configured resource group.
