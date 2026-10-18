export function foundryBaseUrl(endpoint) {
  if (!endpoint) return '';
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('AZURE_OPENAI_ENDPOINT must be a valid Foundry resource URL'); }
  const local = ['localhost', '127.0.0.1', 'host.docker.internal'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS Foundry resource endpoint without credentials or query parameters');
  }
  if (!['', '/', '/openai/v1', '/openai/v1/'].includes(url.pathname)) {
    throw new Error('Use the Foundry resource endpoint, not a project URL or a deployment-specific API path');
  }
  url.pathname = '/openai/v1';
  return url.toString().replace(/\/$/, '');
}

export function modelProvider(env = process.env) {
  const authMode = env.AZURE_OPENAI_AUTH_MODE || 'api-key';
  if (!['api-key', 'azure-cli'].includes(authMode)) throw new Error('AZURE_OPENAI_AUTH_MODE must be api-key or azure-cli');
  const deployment = env.AZURE_OPENAI_DEPLOYMENT || env.OPENCODE_MODEL || 'gpt-6-sol';
  return {
    id: env.OPENCODE_PROVIDER_ID || 'foundry',
    name: env.OPENCODE_PROVIDER_NAME || 'Microsoft Foundry',
    deployment,
    smallDeployment: env.AZURE_OPENAI_SMALL_DEPLOYMENT || env.OPENCODE_SMALL_MODEL || deployment,
    baseURL: foundryBaseUrl(env.AZURE_OPENAI_ENDPOINT),
    authMode,
    apiKey: env.AZURE_OPENAI_API_KEY || '',
  };
}

// This is the only provider data exposed to the browser. No endpoint or credentials.
export function publicModelProvider(env = process.env, inference = null) {
  const provider = modelProvider(env);
  return {
    id: provider.id, name: provider.name, model: provider.deployment,
    transport: 'Direct Azure OpenAI v1 Responses API',
    authentication: provider.authMode === 'azure-cli' ? 'Microsoft Entra ID' : 'API key',
    configured: !!provider.baseURL && (provider.authMode === 'azure-cli' || !!provider.apiKey),
    connected: inference ? inference.success : null,
    verification: inference ? 'inference' : 'configuration',
    lastInferenceAt: inference?.at || null,
    error: inference && !inference.success ? 'The last model request failed. Check the deployment and authentication.' : null,
  };
}
