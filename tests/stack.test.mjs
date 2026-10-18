import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../services/api/server.mjs';
import { createRuntime } from '../services/runtime/server.mjs';
import { createUi } from './fixtures/ui-proxy.mjs';
import { readSse, startSse, writeSse, readJson, json } from '../services/runtime/lib/http.mjs';
import { investigateOpenCode } from '../services/runtime/opencode.mjs';
import { renderConfig } from '../services/runtime/render-config.mjs';
import { prepareAssets } from '../services/runtime/prepare-assets.mjs';
import { markdown } from '../services/ui/public/markdown.js';
import { filterResources, workloadPrompt } from '../services/ui/public/scope.js';
import { conversationInstructions } from '../services/runtime/conversation.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
async function until(fn) {
  for (let i = 0; i < 150; i++) { const result = await fn(); if (result) return result; await delay(20); }
  throw new Error('Condition timed out');
}

test('three-service flow streams, reconnects, rejects concurrent sends, cancels, and persists', async (t) => {
  process.env.DEMO_STEP_DELAY_MS = '5';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-test-'));
  const runtime = createRuntime({ TRIAGE_MODE: 'demo' });
  const runtimeUrl = await listen(runtime);
  let api = await createApi({ dataDir: dir, runtimeUrl });
  let apiUrl = await listen(api);
  const ui = createUi(apiUrl);
  const base = await listen(ui);
  t.after(async () => { await close(ui); await api.shutdown(); await close(api); await close(runtime); await fs.rm(dir, { recursive: true }); });
  const call = async (endpoint, body) => {
    const response = await fetch(`${base}${endpoint}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await call('/api/health')).body.runtime.mode, 'demo');
  assert.equal((await call('/api/sessions', { description: {} })).status, 400);
  assert.equal((await call('/api/sessions', { environment: 'unknown' })).status, 400);
  const session = (await call('/api/sessions', { description: 'ExampleCo staging timeout' })).body.session;
  const endpoint = `/api/sessions/${session.id}`;
  const controller = new AbortController();
  const response = await fetch(`${base}${endpoint}/stream`, { signal: controller.signal });
  const iterator = readSse(response.body)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.event, 'snapshot');
  assert.equal((await call(`${endpoint}/messages`, { content: '' })).status, 400);
  assert.equal((await call(`${endpoint}/messages`, { content: 'Investigate' })).status, 202);
  assert.equal((await call(`${endpoint}/messages`, { content: 'Duplicate' })).status, 409);
  const events = [];
  let streamed = '';
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    events.push(event.event);
    if (event.event === 'message.delta') streamed += event.data.delta;
    if (event.event === 'session.updated' && event.data.session.status === 'complete') break;
  }
  controller.abort();
  assert(events.filter((e) => e === 'message.delta').length > 5);
  assert(events.includes('tool.updated'));
  assert(events.includes('evidence.collected'));
  const snapshot = (await call(endpoint)).body;
  assert.equal(snapshot.messages.at(-1).content, streamed);
  assert.match(streamed, /8\.4 s/);
  assert.match(streamed, /Simulated evidence/);
  assert.equal(snapshot.tools.length, 6);
  const reconnect = new AbortController();
  const reconnectResponse = await fetch(`${base}${endpoint}/stream`, { signal: reconnect.signal });
  const replay = await readSse(reconnectResponse.body)[Symbol.asyncIterator]().next();
  assert.equal(replay.value.data.messages.at(-1).content, streamed);
  reconnect.abort();
  assert.equal((await call(`${endpoint}/messages`, { content: 'What should we check next?', environment: 'production' })).status, 202);
  const cancelled = await call(`${endpoint}/cancel`, {});
  assert.equal(cancelled.body.session.status, 'cancelled');
  assert.equal(cancelled.body.session.incident.environment, 'production');
  assert.equal((await call(endpoint)).body.messages.length, 4);
  await api.shutdown();
  await close(api);
  api = await createApi({ dataDir: dir, runtimeUrl });
  apiUrl = await listen(api);
  const persisted = await fetch(`${apiUrl}${endpoint}`).then((r) => r.json());
  assert.equal(persisted.messages[1].content, streamed);
  assert.equal(persisted.session.status, 'cancelled');
});

test('runtime failures and timeouts end runs and allow retries', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-failure-'));
  const runtime = http.createServer((req, res) => { startSse(res); });
  const runtimeUrl = await listen(runtime);
  const api = await createApi({ dataDir: dir, runtimeUrl, timeout: 50 });
  const base = await listen(api);
  t.after(async () => { await api.shutdown(); await close(api); await close(runtime); await fs.rm(dir, { recursive: true }); });
  const post = (url, body) => fetch(`${base}${url}`, { method: 'POST', body: JSON.stringify(body) });
  const session = await post('/api/sessions', {}).then((r) => r.json());
  const endpoint = `/api/sessions/${session.session.id}`;
  await post(`${endpoint}/messages`, { content: 'Timeout check' });
  const failed = await until(async () => {
    const v = await fetch(`${base}${endpoint}`).then((r) => r.json());
    return v.session.status === 'failed' && v;
  });
  assert.equal(failed.messages.at(-1).complete, true);
  assert.equal((await post(`${endpoint}/messages`, { content: 'Retry' })).status, 202);
});

test('SSE parsing tolerates split Unicode, CRLF, multiline frames, and heartbeats', async () => {
  const source = Buffer.from(': heartbeat\r\n\r\nevent: token\r\ndata: {"text":\r\ndata: "✓ signal"}\r\n\r\n');
  async function* chunks() { for (const byte of source) yield Buffer.from([byte]); }
  const values = [];
  for await (const event of readSse(chunks())) values.push(event);
  assert.deepEqual(values, [{ event: 'token', data: { text: '✓ signal' } }]);
});

test('OpenCode adapter subscribes before prompting, scopes events, normalizes tools and keeps sessions', async (t) => {
  let stream;
  let created = 0;
  let aborted = 0;
  let promptBody;
  const mock = http.createServer(async (req, res) => {
    assert.match(req.headers.authorization, /^Basic /);
    if (req.url === '/session') { created++; return json(res, 200, { id: 'ses_test' }); }
    if (req.url === '/event') { stream = res; startSse(res); return; }
    if (req.url === '/session/ses_test/abort') { aborted++; return json(res, 200, true); }
    if (req.url === '/session/ses_test/message') {
      assert(stream, 'event subscription must precede prompt');
      promptBody = await readJson(req);
      const emit = (type, properties) => writeSse(stream, 'message', { type, properties });
      emit('message.updated', { info: { sessionID: 'ses_test', id: 'user', role: 'user' } });
      emit('message.part.updated', { part: { sessionID: 'ses_test', id: 'usertext', messageID: 'user', type: 'text', text: 'User prompt must not be streamed' } });
      emit('message.part.updated', { part: { sessionID: 'another-session', id: 'other', type: 'text', text: 'Unrelated' } });
      emit('message.updated', { info: { sessionID: 'ses_test', id: 'assistant', role: 'assistant' } });
      emit('message.part.updated', { part: { sessionID: 'ses_test', id: 'part', messageID: 'assistant', type: 'text', text: 'Database ' } });
      emit('message.part.delta', { sessionID: 'ses_test', messageID: 'assistant', partID: 'part', field: 'text', delta: 'latency' });
      emit('message.part.updated', { part: { sessionID: 'ses_test', id: 'part', messageID: 'assistant', type: 'text', text: 'Database latency' } });
      emit('message.part.updated', { part: { sessionID: 'ses_test', id: 'tool', type: 'tool', tool: 'bash', state: { status: 'completed', title: 'Check database', output: 'sensitive-raw-output', time: { start: 10, end: 30 } } } });
      await delay(30);
      json(res, 200, { info: {}, parts: [{ type: 'text', text: 'Database latency confirmed.' }] });
    }
  });
  const url = await listen(mock);
  t.after(() => close(mock));
  const events = [];
  const input = { runId: 'run', content: 'Investigate', incident: { description: 'Timeout' }, messages: [] };
  await investigateOpenCode(input, (event, data) => events.push({ event, data }), new AbortController().signal, { OPENCODE_SERVER_URL: url });
  assert.equal(created, 1);
  assert.equal(events.filter((e) => e.event === 'message.delta').map((e) => e.data.delta).join(''), 'Database latency');
  assert.equal(events.at(-1).event, 'run.completed');
  assert.equal(events.find((e) => e.event === 'message.final').data.content, 'Database latency confirmed.');
  assert(!JSON.stringify(events).includes('sensitive-raw-output'));
  assert.equal(promptBody.model.providerID, 'foundry');
  assert.equal(promptBody.model.modelID, 'gpt-6-sol');
  assert.equal(promptBody.parts[0].text, input.content);
  assert.match(promptBody.system, /capabilities, not an instruction to start an investigation/);
  await investigateOpenCode({ ...input, runtimeSessionId: 'ses_test' }, () => {}, new AbortController().signal, { OPENCODE_SERVER_URL: url });
  assert.equal(created, 1, 'follow-up must reuse runtime session');
  assert.equal(aborted, 0);
});

test('live chat does not require Azure discovery or mark a tool-free reply as an investigation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-chat-'));
  let stream;
  let prompt;
  const mock = http.createServer(async (req, res) => {
    if (req.url === '/session') return json(res, 200, { id: 'ses_chat' });
    if (req.url === '/event') { stream = res; startSse(res); return; }
    if (req.url === '/session/ses_chat/message') {
      prompt = await readJson(req);
      const text = 'Hi! How can I help?';
      writeSse(stream, 'message', { type: 'message.updated', properties: { info: { sessionID: 'ses_chat', id: 'assistant', role: 'assistant' } } });
      writeSse(stream, 'message', { type: 'message.part.updated', properties: { part: { sessionID: 'ses_chat', id: 'text', messageID: 'assistant', type: 'text', text } } });
      await delay(20);
      return json(res, 200, { info: {}, parts: [{ type: 'text', text }] });
    }
    json(res, 404, {});
  });
  const mockUrl = await listen(mock);
  // No Azure subscription/login or working gateway: a greeting must still work.
  const runtime = createRuntime({ TRIAGE_MODE: 'opencode', TRIAGE_LIVE_AZURE_ENABLED: 'true', AZURE_RESOURCE_GROUP: 'test-group', OPENCODE_SERVER_URL: mockUrl });
  const runtimeUrl = await listen(runtime);
  const api = await createApi({ dataDir: dir, runtimeUrl });
  const base = await listen(api);
  t.after(async () => { await api.shutdown(); await close(api); await close(runtime); await close(mock); await fs.rm(dir, { recursive: true }); });
  const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const { session } = await post('/api/sessions', { description: 'Hi' });
  const endpoint = `/api/sessions/${session.id}`;
  const accepted = await post(`${endpoint}/messages`, { content: 'Hi' });
  assert.equal(accepted.session.status, 'responding');
  const controller = new AbortController();
  const response = await fetch(`${base}${endpoint}/stream`, { signal: controller.signal });
  const statuses = [];
  for await (const { data } of readSse(response.body)) {
    if (data.session) statuses.push(data.session.status);
    if (data.session?.status === 'complete') break;
  }
  controller.abort();
  const result = await fetch(`${base}${endpoint}`).then((r) => r.json());
  assert(!statuses.includes('investigating'));
  assert.equal(result.session.run_kind, 'conversation');
  assert.equal(result.tools.length, 0);
  assert.equal(result.messages.at(-1).content, 'Hi! How can I help?');
  assert.equal(prompt.parts[0].text, 'Hi');
  assert.match(prompt.system, /For greetings, thanks, capability questions/);
  assert.match(prompt.system, /Available live scope: resource group test-group/);
});

test('Foundry config registers deployment aliases and gates live Azure without embedding placeholders', async () => {
  const template = JSON.parse(await fs.readFile(new URL('../services/runtime/config/opencode.template.json', import.meta.url), 'utf8'));
  const config = renderConfig(template, { AZURE_OPENAI_DEPLOYMENT: 'large', AZURE_OPENAI_SMALL_DEPLOYMENT: 'small', AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', AZURE_OPENAI_API_KEY: 'test-only', OPENCODE_MODEL_INPUT_LIMIT: '100000' });
  assert.equal(config.provider.foundry.options.baseURL, 'https://example.openai.azure.com/openai/v1');
  assert.equal(config.provider.foundry.options.apiKey, 'test-only');
  assert.equal(config.provider.foundry.options.headers['api-key'], 'test-only');
  assert.equal(config.provider.foundry.npm, '@ai-sdk/openai');
  assert(config.provider.foundry.models.small);
  assert.equal(config.provider.foundry.models.large.limit.input, 100000);
  assert.equal(config.agent['triage-agent'].permission.bash['az *'], 'deny');
  assert(!JSON.stringify(config).includes('__MODEL'));
  assert.throws(() => renderConfig(template, { OPENCODE_MODEL_OUTPUT_LIMIT: '-1' }));
  const defaults = renderConfig(template, {});
  assert.equal(defaults.model, 'foundry/gpt-6-sol');
  assert.equal(defaults.small_model, 'foundry/gpt-6-sol');
  assert.deepEqual(defaults.provider.foundry.models['gpt-6-sol'].limit, { context: 1050000, input: 922000, output: 16000 });
  assert.equal(defaults.compaction.reserved, 50000);
  const live = renderConfig(template, { TRIAGE_LIVE_AZURE_ENABLED: 'true', AZURE_RESOURCE_GROUP: 'example-observability' });
  const permissions = live.agent['triage-agent'].permission;
  assert.equal(permissions.bash['az *'], 'deny');
  assert.equal(permissions.bash['date*'], 'deny');
  assert.equal(permissions.bash['python3 /workspace/tools/demo-observability.py*'], 'deny');
  assert.equal(permissions.bash['python3 /workspace/tools/azure-observability.py*'], 'allow');
  assert.equal(permissions.read['*'], 'deny');
  assert.equal(permissions.skill['azure-resource-group'], 'allow');
});

test('runtime preparation preserves imported instruction bodies, registers the skill and gates Azure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-assets-'));
  t.after(() => fs.rm(dir, { recursive: true }));
  const root = new URL('../services/runtime/', import.meta.url);
  await fs.cp(new URL('agents', root), path.join(dir, 'agents'), { recursive: true });
  await fs.cp(new URL('skills', root), path.join(dir, 'skills'), { recursive: true });
  const original = await fs.readFile(path.join(dir, 'agents/triage-agent.md'), 'utf8');
  const skill = await fs.readFile(path.join(dir, 'skills/azure-observability-demo/SKILL.md'), 'utf8');
  const body = (markdown) => markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  await prepareAssets(dir, {});
  const agent = await fs.readFile(path.join(dir, '.opencode/agent/triage-agent.md'), 'utf8');
  const preparedSkill = await fs.readFile(path.join(dir, '.opencode/skills/azure-observability-demo/SKILL.md'), 'utf8');
  assert.equal(body(agent), body(original));
  assert(preparedSkill.endsWith(skill));
  assert.match(preparedSkill, /^---\nname: azure-observability-demo\n/);
  assert.match(agent, /  skill:\n    "\*": deny\n    azure-observability-demo: allow/);
  assert.match(agent, /    "az \*": deny\n  skill:/);
  await prepareAssets(dir, { TRIAGE_LIVE_AZURE_ENABLED: 'true' });
  const live = await fs.readFile(path.join(dir, '.opencode/agent/triage-agent.md'), 'utf8');
  assert(!live.includes('"az *": deny'));
  assert(live.includes('"az account show*": allow'));
  await prepareAssets(dir, { TRIAGE_LIVE_AZURE_ENABLED: 'true', AZURE_RESOURCE_GROUP: 'example-observability' });
  const scoped = await fs.readFile(path.join(dir, '.opencode/agent/triage-agent.md'), 'utf8');
  assert(scoped.includes('"az *": deny'));
  assert(scoped.includes('"date*": deny'));
  assert(scoped.includes('"python3 /workspace/tools/azure-observability.py*": allow'));
  assert(scoped.includes('azure-resource-group: allow'));
  assert.equal(body(scoped), body(original));
  assert.equal(await fs.readFile(path.join(dir, 'agents/triage-agent.md'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(dir, 'skills/azure-observability-demo/SKILL.md'), 'utf8'), skill);
});

test('chat Markdown escapes hostile HTML and renders evidence tables', () => {
  const html = markdown('## Evidence\n\n<script>alert(1)</script>\n\n| Source | Signal |\n| --- | --- |\n| **DB** | `8.4s` |');
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;'));
  assert(html.includes('<table>'));
  assert(html.includes('<strong>DB</strong>'));
});

test('environment selection filters resources and scopes cross-layer prompts', () => {
  const resources = [
    { name: 'example-backend-api-STAGING' },
    { name: 'example-backend-prod' },
    { name: 'exampleprod' },
    { name: 'example-read-replica' },
  ];
  assert.deepEqual(filterResources(resources, 'staging'), [resources[0]]);
  assert.deepEqual(filterResources(resources, 'production'), [resources[1], resources[2]]);
  assert.equal(filterResources(resources, 'all').length, 4);
  const prompt = workloadPrompt('staging-resource', 'staging');
  assert.match(prompt, /--environment staging/);
  assert.match(prompt, /console\/system logs/);
  assert.match(prompt, /database metrics\/logs/);
  const system = conversationInstructions({ TRIAGE_LIVE_AZURE_ENABLED: 'true', AZURE_RESOURCE_GROUP: 'group' }, { environment: 'production' });
  assert.match(system, /Selected environment for THIS turn: production/);
  assert.match(system, /--environment production/);
  assert.match(system, /workload-check/);
  assert.match(system, /Greetings and general questions still need no tools/);
});
