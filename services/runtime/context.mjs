import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { publicModelProvider } from './model-provider.mjs';

export function contextReader(env, lastInference = () => null) {
  let cached;
  let refreshed = 0;
  let pending;
  const decorate = (value) => ({ ...value, provider: env.TRIAGE_MODE === 'opencode' ? publicModelProvider(env, lastInference()) : null });
  return async () => {
    if (pending) return decorate(await pending);
    if (cached && Date.now() - refreshed < 60000) return decorate(cached);
    pending = (async () => {
      const live = env.TRIAGE_MODE === 'opencode' && env.TRIAGE_LIVE_AZURE_ENABLED === 'true';
      const context = { mode: live ? 'live-azure' : env.TRIAGE_MODE || 'demo', resourceGroup: env.AZURE_RESOURCE_GROUP || null };
      if (!live) return context;
      const azure = promisify(execFile)('python3', [fileURLToPath(new URL('./tools/azure-observability.py', import.meta.url)), 'inventory'], {
        env: { ...process.env, ...env }, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
      }).then(({ stdout }) => JSON.parse(stdout)).catch(() => ({ connected: false, resourceGroup: env.AZURE_RESOURCE_GROUP, error: 'Azure discovery failed. Check the runtime login, subscription, resource group, and Reader access.' }));
      return { ...context, azure: await azure };
    })();
    try { cached = await pending; refreshed = Date.now(); return decorate(cached); }
    finally { pending = null; }
  };
}
