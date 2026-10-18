// Optional Docker integration check: real OpenCode, deterministic fake Responses API.
// No model credentials or live Azure access. Run after `docker compose build runtime`.
import http from 'node:http';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { readJson, readSse, startSse, writeSse } from '../services/runtime/lib/http.mjs';

const docker = promisify(execFile);
let providerCalls = 0;
let toolCalled = false;
let skillCalled = false;
const gateway = http.createServer(async (req, res) => {
  const body = await readJson(req, 4 * 1024 * 1024);
  providerCalls++;
  const callSkill = body.tools?.some((t) => t.name === 'skill') && !skillCalled;
  const callTool = !callSkill && body.tools?.some((t) => t.name === 'bash') && !toolCalled;
  const functionCall = callSkill || callTool;
  const responseId = `resp_${providerCalls}`;
  const text = '## Investigation summary\n\nSeeded evidence confirms database latency and queue backlog. This is a protocol smoke test.';
  const output = functionCall ? {
    id: `fc_${providerCalls}`, type: 'function_call', call_id: `call_${providerCalls}`, name: callSkill ? 'skill' : 'bash',
    arguments: JSON.stringify(callSkill ? { name: 'azure-observability-demo' } : { command: 'python3 /workspace/tools/demo-observability.py --incident "ExampleCo staging timeout"', description: 'Collect seeded evidence' }), status: 'completed',
  } : {
    id: `msg_${providerCalls}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  assert.equal(body.model, 'gpt-6-sol');
  const response = { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'gpt-6-sol', status: 'completed', output: [output], usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 } };
  startSse(res);
  let sequence = 0;
  const emit = (type, data) => writeSse(res, type, { type, sequence_number: sequence++, ...data });
  emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
  emit('response.output_item.added', { output_index: 0, item: { ...output, status: 'in_progress', ...(functionCall ? { arguments: '' } : { content: [] }) } });
  if (functionCall) {
    if (callSkill) skillCalled = true;
    else toolCalled = true;
    emit('response.function_call_arguments.delta', { item_id: output.id, output_index: 0, delta: output.arguments });
    emit('response.function_call_arguments.done', { item_id: output.id, output_index: 0, arguments: output.arguments });
  } else {
    emit('response.content_part.added', { item_id: output.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const delta of text.match(/.{1,20}/gs)) {
      emit('response.output_text.delta', { item_id: output.id, output_index: 0, content_index: 0, delta });
      await delay(20);
    }
    emit('response.output_text.done', { item_id: output.id, output_index: 0, content_index: 0, text });
    emit('response.content_part.done', { item_id: output.id, output_index: 0, content_index: 0, part: output.content[0] });
  }
  emit('response.output_item.done', { output_index: 0, item: output });
  emit('response.completed', { response });
  res.end();
});
gateway.listen(0, '0.0.0.0');
await once(gateway, 'listening');
const name = `triage-protocol-smoke-${process.pid}`;
try {
  await docker('docker', ['run', '-d', '--rm', '--name', name, '--add-host', 'host.docker.internal:host-gateway', '-p', '127.0.0.1::4096',
    '-e', 'TRIAGE_MODE=opencode', '-e', 'OPENCODE_SERVER_PASSWORD=smoke-test', '-e', 'OPENAI_API_KEY=smoke-test',
    '-e', `LITELLM_BASE_URL=http://host.docker.internal:${gateway.address().port}/v1`, 'triage-agent-demo-runtime']);
  const { stdout } = await docker('docker', ['port', name, '4096']);
  const base = `http://${stdout.trim()}`;
  let healthy = false;
  for (let i = 0; i < 90; i++) {
    healthy = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
    if (healthy) break;
    await delay(1000);
  }
  assert(healthy, 'OpenCode runtime must become healthy');
  const response = await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(90000),
    body: JSON.stringify({ runId: 'smoke', content: 'Investigate the demo incident using the seeded tool.', incident: { description: 'ExampleCo staging timeout' }, messages: [] }),
  });
  const events = [];
  for await (const event of readSse(response.body)) events.push(event);
  console.log({ providerCalls, skillCalled, toolCalled, eventTypes: [...new Set(events.map((e) => e.event))] });
  assert(events.some((e) => e.event === 'message.delta'), 'real OpenCode must stream text');
  assert(events.some((e) => e.event === 'tool.updated' && e.data.status === 'completed'), 'real OpenCode must execute the seeded diagnostic tool');
  assert(events.some((e) => e.event === 'tool.updated' && e.data.label === 'skill' && e.data.status === 'completed'), 'real OpenCode must load the imported observability skill');
  assert.equal(events.at(-1).event, 'run.completed');
  assert(toolCalled);
  console.log('PASS: real OpenCode → GPT-6 Sol Responses API → imported skill → seeded tool → streamed answer');
} finally {
  await docker('docker', ['stop', name]).catch(() => {});
  gateway.closeAllConnections();
  gateway.close();
}
