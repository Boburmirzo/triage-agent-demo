# Triage Agent Demo

Lightweight, offline-safe demo for the talk **Build Your Own Azure Observability Agent**.

This folder now contains two demo options:

- A lightweight browser UI/API simulation with no dependencies.
- A Dockerized OpenCode runtime with a demo `triage-agent`, demo skill, and offline observability tool.

The lightweight UI always uses simulated evidence. The Dockerized OpenCode runtime can run in either seeded offline mode or optional live Azure read-only mode after users configure Azure authentication and RBAC.

## Option 1: Run The Lightweight UI Demo

```bash
npm start
```

Then open:

```text
http://localhost:7070
```

Optional port override:

```bash
PORT=7071 npm start
```

## Option 2: Run The OpenCode Agent Demo With Docker

Build the OpenCode demo runtime:

```bash
docker build -t triage-agent-demo-opencode .
```

Run with an OpenAI-compatible endpoint:

```bash
docker run --rm -p 4096:4096 \
  -e OPENCODE_SERVER_PASSWORD="demo-password" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e OPENCODE_PROVIDER_ID="openai" \
  -e OPENCODE_PROVIDER_NAME="OpenAI" \
  -e OPENAI_BASE_URL="https://api.openai.com/v1" \
  -e OPENCODE_MODEL="gpt-4o-mini" \
  triage-agent-demo-opencode
```

Or use Docker Compose:

```bash
cp .env.example .env
# Edit .env and set OPENAI_API_KEY.
docker compose up --build
```

Verify OpenCode is running:

```bash
curl -u "opencode:demo-password" "http://localhost:4096/global/health"
curl -u "opencode:demo-password" "http://localhost:4096/agent"
```

Create an OpenCode session:

```bash
curl -u "opencode:demo-password" \
  -H "content-type: application/json" \
  -d '{"title":"ExampleCo staging timeout demo"}' \
  "http://localhost:4096/session"
```

Send a message to the demo triage agent. Replace `<session-id>` with the returned session ID:

```bash
curl -u "opencode:demo-password" \
  -H "content-type: application/json" \
  -d '{
    "agent":"triage-agent",
    "parts":[
      {
        "type":"text",
        "text":"ExampleCo staging report failed with timeout around 10:00 UTC. Please investigate using the demo observability tool and return the structured RCA."
      }
    ]
  }' \
  "http://localhost:4096/session/<session-id>/message"
```

The agent is expected to run:

```bash
python3 /workspace/tools/demo-observability.py --incident "ExampleCo staging report failed with timeout around 10:00 UTC"
```

and then produce a structured RCA.

## Option 3: Use The OpenCode Demo Against Your Azure Account

The Dockerized demo is intentionally close to the real `opencode-agent` triage runtime. It includes Azure CLI and a read-only OpenCode command allowlist for Azure diagnostics.

Use this mode only in a test subscription or with least-privilege read-only RBAC.

### Required Azure Permissions

Grant the identity used by the container only read-oriented roles, for example:

- `Reader`
- `Monitoring Reader`
- `Log Analytics Reader`
- `Storage Queue Data Reader` only if queue diagnostics are needed

Avoid broad write-capable roles such as `Contributor` for this demo.

### Local Docker With Existing Azure CLI Login

Authenticate on the host first:

```bash
az login
az account set --subscription "<subscription-id>"
```

Run the container and mount your Azure CLI profile:

```bash
docker run --rm -p 4096:4096 \
  -v "$HOME/.azure:/home/opencode/.azure" \
  -e OPENCODE_SERVER_PASSWORD="demo-password" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e OPENCODE_PROVIDER_ID="openai" \
  -e OPENCODE_PROVIDER_NAME="OpenAI" \
  -e OPENAI_BASE_URL="https://api.openai.com/v1" \
  -e OPENCODE_MODEL="gpt-4o-mini" \
  -e AZURE_SUBSCRIPTION_ID="<subscription-id>" \
  triage-agent-demo-opencode
```

Then ask the agent:

```text
Use live Azure diagnostics. First verify az account show, then list resource groups and summarize observability resources in this subscription. Do not print secrets.
```

### Azure Container Apps With Managed Identity

When deploying the demo container to Azure Container Apps, assign a managed identity and grant it the read-only roles above. Then set:

```text
AZURE_LOGIN_WITH_MANAGED_IDENTITY=true
AZURE_CLIENT_ID=<user-assigned-managed-identity-client-id-if-used>
AZURE_SUBSCRIPTION_ID=<subscription-id>
```

At startup, `entrypoint.sh` runs `az login --identity` and selects `AZURE_SUBSCRIPTION_ID` when provided.

### Live Azure Commands The Agent Can Use

The demo agent keeps bash deny-by-default and allows read-only commands similar to the real triage agent:

```text
az account show/list
az group list
az provider list/show
az resource list/show
az graph query
az monitor activity-log list
az monitor app-insights query
az monitor log-analytics query/workspace list
az monitor metrics list
az containerapp list/show/revision list/env list/logs show
az functionapp list/show/function list
az storage account/container/blob/queue read commands
az storage message peek
az sql server/db list/show
az rest GET only
```

The allowlist intentionally does not include restarts, scale changes, deployments, deletes, secret reads, queue deletes, or SQL writes.

## OpenCode Demo Runtime Files

- `Dockerfile` builds the OpenCode server runtime.
- `entrypoint.sh` renders OpenCode config from environment variables and starts `opencode serve`.
- `config/opencode.template.json` registers the demo provider, model, agent, skill, and permissions.
- `agents/triage-agent.md` defines the demo observability triage agent.
- `skills/azure-observability-demo/SKILL.md` explains the demo workflow and constraints.
- `tools/demo-observability.py` returns seeded offline Azure observability evidence.
- `.env.example` shows the main runtime settings.

## What It Demonstrates

- Multi-step incident triage flow.
- Agent progress events similar to the production UI.
- Azure observability sources such as Application Insights, Container Apps, queues, dependencies, and deployment metadata.
- Structured RCA output with severity, evidence, recommended actions, and confidence.
- Clear separation between demo simulation and production diagnostics.
- OpenCode agent packaging with a deny-by-default tool policy.
- A safe local diagnostic tool that replaces live Azure queries for conference demos.
- Optional live Azure read-only diagnostics for users who want to try the pattern in their own subscription.

## Demo Prompt

Try this prompt:

```text
ExampleCo staging report failed with timeout around 10:00 UTC. Please investigate.
```

## Production Comparison

The full production-oriented design lives in:

- `../opencode-agent/agents/triage-agent.md`
- `../opencode-agent/docs/triage-agent-workflow.md`
- `../opencode-agent/docs/triage-agent-ui-plan.md`
- `../triage-agent/`

The real version uses the same basic OpenCode pattern, but adds stronger production controls: managed identity, Azure CLI or future diagnostic APIs, PostgreSQL sessions, Entra authentication, audit storage, redaction, resource scoping, and stricter operational governance.

## Safety Notes

- The demo Docker runtime installs Azure CLI for optional live read-only diagnostics.
- The demo agent cannot edit files or use web fetch.
- Bash is deny-by-default and only allows selected read-only Azure commands plus `date*` and the local demo evidence tool.
- The seeded evidence is safe for public demos and contains no customer payloads, credentials, tokens, or live resource access.
- Live Azure mode depends on the user's Azure auth and RBAC. Use least privilege and test subscriptions first.
