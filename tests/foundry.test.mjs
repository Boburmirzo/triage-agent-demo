import test from 'node:test';
import assert from 'node:assert/strict';
import { foundryBaseUrl, modelProvider, publicModelProvider } from '../services/runtime/model-provider.mjs';
import { createFoundryAuth } from '../services/runtime/foundry-auth.mjs';

test('Foundry resource URLs normalize to v1 and reject project URLs or embedded credentials', () => {
  for (const suffix of ['', '/', '/openai/v1', '/openai/v1/']) assert.equal(foundryBaseUrl(`https://example.openai.azure.com${suffix}`), 'https://example.openai.azure.com/openai/v1');
  assert.equal(foundryBaseUrl('https://example.services.ai.azure.com'), 'https://example.services.ai.azure.com/openai/v1');
  for (const url of ['https://example.services.ai.azure.com/api/projects/test', 'https://example.openai.azure.com/openai/deployments/gpt-6-sol', 'https://user:secret@example.openai.azure.com', 'http://example.openai.azure.com', 'https://example.openai.azure.com?api-key=secret']) assert.throws(() => foundryBaseUrl(url));
});

test('Foundry deployment aliases are authoritative and public metadata contains no secrets or endpoint', () => {
  const env = { AZURE_OPENAI_ENDPOINT: 'https://private-resource.openai.azure.com', AZURE_OPENAI_API_KEY: 'test-private-value', AZURE_OPENAI_DEPLOYMENT: 'triage-deployment', OPENCODE_MODEL: 'old-model' };
  const provider = modelProvider(env);
  assert.equal(provider.deployment, 'triage-deployment');
  assert.equal(provider.smallDeployment, 'triage-deployment');
  const exposed = publicModelProvider(env);
  assert.equal(exposed.name, 'Microsoft Foundry');
  assert.equal(exposed.connected, null, 'configuration must not claim a verified inference');
  assert.equal(exposed.configured, true);
  assert(!JSON.stringify(exposed).includes('test-private-value'));
  assert(!JSON.stringify(exposed).includes('private-resource'));
  assert.equal(publicModelProvider(env, { success: true, at: '2026-01-01T00:00:00Z' }).verification, 'inference');
});

test('API-key authentication uses the Azure header without requiring Azure CLI', async () => {
  const headers = createFoundryAuth({ AZURE_OPENAI_API_KEY: 'test-only' }, () => { throw new Error('CLI must not be used'); });
  assert.deepEqual(await headers(), { 'api-key': 'test-only' });
  await assert.rejects(createFoundryAuth({})(), /AZURE_OPENAI_API_KEY/);
});

test('Entra authentication shares concurrent refreshes and refreshes tokens before expiry', async () => {
  let count = 0;
  const token = { token: 'test-access-token', expiresAt: Date.now() + 3600000 };
  const headers = createFoundryAuth({ AZURE_OPENAI_AUTH_MODE: 'azure-cli', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com' }, async () => { count++; return token; });
  const values = await Promise.all([headers(), headers(), headers()]);
  assert.equal(count, 1);
  assert.equal(values[0].Authorization, 'Bearer test-access-token');
  await headers();
  assert.equal(count, 1);
  token.expiresAt = Date.now() + 60000;
  await headers();
  assert.equal(count, 2);
  await assert.rejects(createFoundryAuth({ AZURE_OPENAI_AUTH_MODE: 'azure-cli', AZURE_OPENAI_ENDPOINT: 'http://localhost:1234' })(), /HTTPS/);
});
