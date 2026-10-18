import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { providerEnv } from './provider-env.mjs';

export function renderConfig(template, env = process.env) {
  const provider = env.OPENCODE_PROVIDER_ID || 'litellm';
  const model = env.OPENCODE_MODEL || 'gpt-6-sol';
  const small = env.OPENCODE_SMALL_MODEL || model;
  const positive = (name, fallback) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
    return value;
  };
  const values = {
    __PROVIDER_ID__: provider, __MODEL_ID__: model, __SMALL_MODEL_ID__: small,
    __DEFAULT_AGENT__: env.OPENCODE_DEFAULT_AGENT || 'triage-agent',
    __PROVIDER_NAME__: env.OPENCODE_PROVIDER_NAME || 'LiteLLM',
    __LITELLM_BASE_URL__: env.LITELLM_BASE_URL || env.OPENAI_BASE_URL || 'http://host.docker.internal:4000/v1',
    __API_KEY__: env.OPENAI_API_KEY || env.LITELLM_API_KEY || '',
    __MODEL_DISPLAY_NAME__: env.OPENCODE_MODEL_DISPLAY_NAME || model,
    __MODEL_CONTEXT_LIMIT__: positive('OPENCODE_MODEL_CONTEXT_LIMIT', 1050000),
    __MODEL_OUTPUT_LIMIT__: positive('OPENCODE_MODEL_OUTPUT_LIMIT', 16000),
    __COMPACTION_RESERVED__: positive('OPENCODE_COMPACTION_RESERVED', 50000),
  };
  function render(value) {
    if (Array.isArray(value)) return value.map(render);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [values[k] ?? k, render(v)]));
    if (typeof value !== 'string') return value;
    return values[value] ?? value.replace(/__[A-Z0-9_]+__/g, (key) => values[key] ?? key);
  }
  const config = render(template);
  const models = config.provider[provider].models;
  models[model].limit.input = positive('OPENCODE_MODEL_INPUT_LIMIT', 922000);
  if (small !== model) models[small] = { ...structuredClone(models[model]), name: small };
  // A headless run must never wait for an interactive permission/question prompt.
  config.permission.question = 'deny';
  config.permission.task = 'deny';
  if (env.TRIAGE_LIVE_AZURE_ENABLED !== 'true') {
    config.agent['triage-agent'].permission.bash['az *'] = 'deny';
  }
  if (env.TRIAGE_LIVE_AZURE_ENABLED === 'true' && env.AZURE_RESOURCE_GROUP) {
    const permissions = config.agent['triage-agent'].permission;
    permissions.bash['az *'] = 'deny';
    permissions.bash['date*'] = 'deny';
    permissions.bash['python3 /workspace/tools/demo-observability.py*'] = 'deny';
    permissions.bash['python3 /workspace/tools/azure-observability.py*'] = 'allow';
    permissions.skill['azure-resource-group'] = 'allow';
    // Credential files are mounted outside the diagnostic workspace.
    permissions.read = { '*': 'deny', '/workspace/AGENTS.md': 'allow', '/workspace/skills/**': 'allow', '/workspace/.opencode/skills/**': 'allow' };
  }
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = renderConfig(JSON.parse(await fs.readFile(process.argv[2], 'utf8')), providerEnv());
  await fs.writeFile(process.argv[3], JSON.stringify(config, null, 2), { mode: 0o600 });
}
