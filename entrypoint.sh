#!/bin/sh
set -eu

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
CONFIG_FILE="${OPENCODE_CONFIG:-$CONFIG_DIR/opencode.json}"
TEMPLATE="${OPENCODE_TEMPLATE:-/workspace/config/opencode.template.json}"

mkdir -p "$CONFIG_DIR"

if [ "${AZURE_LOGIN_WITH_MANAGED_IDENTITY:-false}" = "true" ]; then
  if [ -n "${AZURE_CLIENT_ID:-}" ]; then
    az login --identity --client-id "$AZURE_CLIENT_ID" --allow-no-subscriptions >/dev/null
  else
    az login --identity --allow-no-subscriptions >/dev/null
  fi

  if [ -n "${AZURE_SUBSCRIPTION_ID:-}" ]; then
    az account set --subscription "$AZURE_SUBSCRIPTION_ID" >/dev/null
  fi
fi

node - "$TEMPLATE" > "$CONFIG_FILE" <<'EOF'
const fs = require('fs');

const templatePath = process.argv[2];
const providerID = process.env.OPENCODE_PROVIDER_ID || 'openai';
const modelID = process.env.OPENCODE_MODEL || 'gpt-4o-mini';
const smallModelID = process.env.OPENCODE_SMALL_MODEL || modelID;
const values = {
  __PROVIDER_ID__: providerID,
  __MODEL_ID__: modelID,
  __SMALL_MODEL_ID__: smallModelID,
  __DEFAULT_AGENT__: process.env.OPENCODE_DEFAULT_AGENT || 'triage-agent',
  __PROVIDER_NAME__: process.env.OPENCODE_PROVIDER_NAME || 'OpenAI',
  __OPENAI_BASE_URL__: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  __API_KEY__: process.env.OPENAI_API_KEY || '',
  __MODEL_DISPLAY_NAME__: process.env.OPENCODE_MODEL_DISPLAY_NAME || modelID,
  __MODEL_CONTEXT_LIMIT__: Number(process.env.OPENCODE_MODEL_CONTEXT_LIMIT || 128000),
  __MODEL_OUTPUT_LIMIT__: Number(process.env.OPENCODE_MODEL_OUTPUT_LIMIT || 8192),
};

function render(value) {
  if (Array.isArray(value)) return value.map(render);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [values[key] ?? key, render(child)]));
  }
  if (typeof value === 'string' && values[value] !== undefined) return values[value];
  if (typeof value === 'string') return value.replace(/__([A-Z0-9_]+)__/g, (match) => values[match] ?? match);
  return value;
}

process.stdout.write(JSON.stringify(render(JSON.parse(fs.readFileSync(templatePath, 'utf8'))), null, 2));
EOF

exec opencode serve --hostname "$OPENCODE_HOSTNAME" --port "$OPENCODE_PORT"
