import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function providerEnv(env = process.env) {
  if (!env.TRIAGE_PROVIDER_ENV_FILE) return env;
  const source = parseEnv(readFileSync(env.TRIAGE_PROVIDER_ENV_FILE, 'utf8'));
  const result = { ...env };
  // Read only the gateway settings; never import unrelated application secrets.
  for (const key of ['LITELLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'LITELLM_API_KEY']) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}
