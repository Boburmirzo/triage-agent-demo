#!/bin/sh
set -eu

node /workspace/prepare-assets.mjs /workspace
if [ -n "${TRIAGE_AZURE_LOGIN_SOURCE:-}" ] && [ -f /workspace/bootstrap-azure.mjs ]; then
  node /workspace/bootstrap-azure.mjs
fi

if [ "${TRIAGE_MODE:-demo}" = "demo" ]; then
  exec node /workspace/server.mjs
fi

if [ "${TRIAGE_MODE:-demo}" != "opencode" ]; then
  printf 'TRIAGE_MODE must be demo or opencode\n' >&2
  exit 1
fi

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

node /workspace/render-config.mjs "$TEMPLATE" "$CONFIG_FILE"
export OPENCODE_CONFIG="$CONFIG_FILE"
exec node /workspace/server.mjs
