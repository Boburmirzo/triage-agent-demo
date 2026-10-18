import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { providerEnv } from './provider-env.mjs';

export function contextReader(env) {
  let cached;
  let refreshed = 0;
  let pending;
  return async () => {
    if (pending) return pending;
    if (cached && Date.now() - refreshed < 60000) return cached;
    pending = (async () => {
      const live = env.TRIAGE_MODE === 'opencode' && env.TRIAGE_LIVE_AZURE_ENABLED === 'true';
      const context = { mode: live ? 'live-azure' : env.TRIAGE_MODE || 'demo', resourceGroup: env.AZURE_RESOURCE_GROUP || null };
      if (!live) return context;
      const azure = promisify(execFile)('python3', [fileURLToPath(new URL('./tools/azure-observability.py', import.meta.url)), 'inventory'], {
        env: { ...process.env, ...env }, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      }).then(({ stdout }) => JSON.parse(stdout)).catch(() => ({ connected: false, resourceGroup: env.AZURE_RESOURCE_GROUP, error: 'Azure discovery failed. Check the runtime login, subscription, resource group, and Reader access.' }));
      const provider = (async () => {
        const settings = providerEnv(env);
        const base = settings.LITELLM_BASE_URL || settings.OPENAI_BASE_URL || 'http://host.docker.internal:4000/v1';
        const key = settings.OPENAI_API_KEY || settings.LITELLM_API_KEY || '';
        try {
          const response = await fetch(`${base.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
          if (!response.ok) return { connected: false, error: `Gateway model discovery returned HTTP ${response.status}.` };
          const model = env.OPENCODE_MODEL || 'gpt-6-sol';
          const available = (await response.json()).data?.some((item) => item.id === model);
          return { connected: !!available, model, error: available ? null : 'Configured model was not listed by the gateway.' };
        } catch { return { connected: false, error: 'Gateway unavailable. Check the LiteLLM connection.' }; }
      })();
      const [azureResult, providerResult] = await Promise.all([azure, provider]);
      return { ...context, azure: azureResult, provider: providerResult };
    })();
    try { cached = await pending; refreshed = Date.now(); return cached; }
    finally { pending = null; }
  };
}
