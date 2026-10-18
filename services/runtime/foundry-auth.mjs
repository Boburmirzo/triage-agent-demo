import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelProvider } from './model-provider.mjs';

async function azureCliToken() {
  try {
    const { stdout } = await promisify(execFile)('az', [
      'account', 'get-access-token', '--resource', 'https://ai.azure.com', '--output', 'json', '--only-show-errors',
    ], { timeout: 20000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    if (!result.accessToken || !Number(result.expires_on)) throw new Error();
    return { token: result.accessToken, expiresAt: Number(result.expires_on) * 1000 };
  } catch { throw new Error('Foundry authentication failed. Authenticate the runtime Azure CLI or configure AZURE_OPENAI_API_KEY.'); }
}

export function createFoundryAuth(env = process.env, loadToken = azureCliToken) {
  const provider = modelProvider(env);
  let cached;
  let pending;
  return async () => {
    if (provider.authMode === 'api-key') {
      if (!provider.apiKey) throw new Error('AZURE_OPENAI_API_KEY is required for API-key authentication');
      return { 'api-key': provider.apiKey };
    }
    if (!provider.baseURL.startsWith('https://')) throw new Error('Microsoft Entra ID requires an HTTPS Foundry endpoint');
    // Refresh before expiry, including during long multi-step investigations.
    if (!cached || cached.expiresAt - Date.now() < 300000) {
      pending ||= loadToken().finally(() => { pending = null; });
      cached = await pending;
    }
    return { Authorization: `Bearer ${cached.token}` };
  };
}
