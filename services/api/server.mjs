import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { json, readJson, startSse, writeSse, readSse } from '../runtime/lib/http.mjs';

const summary = ({ messages, tools, evidence, timeline, runtimeSessionId, ...session }) => session;

export async function createApi({ dataDir = process.env.TRIAGE_DATA_DIR || './data', runtimeUrl = process.env.TRIAGE_RUNTIME_URL || 'http://127.0.0.1:4096', timeout = Number(process.env.TRIAGE_RUN_TIMEOUT_MS || 600000) } = {}) {
  await fs.mkdir(dataDir, { recursive: true });
  const sessions = new Map();
  const subscribers = new Map();
  const runs = new Map();
  const writes = new Map();
  function persist(session) {
    const content = JSON.stringify(session);
    const file = path.join(dataDir, `${session.id}.json`);
    const write = (writes.get(session.id) || Promise.resolve()).catch(() => {}).then(async () => {
      await fs.writeFile(`${file}.tmp`, content, { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
    });
    writes.set(session.id, write);
    return write;
  }
  for (const file of await fs.readdir(dataDir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
    const session = JSON.parse(await fs.readFile(path.join(dataDir, file), 'utf8'));
    if (file !== `${session.id}.json`) throw new Error('Invalid persisted session');
    if (['responding', 'investigating'].includes(session.status)) {
      session.status = 'interrupted';
      session.error = 'The API restarted during this response. Send a message to retry.';
      for (const tool of session.tools) if (['pending', 'running'].includes(tool.status)) tool.status = 'cancelled';
      await persist(session);
    }
    sessions.set(session.id, session);
  }
  const publish = (id, event, payload) => {
    for (const res of subscribers.get(id) || []) writeSse(res, event, payload);
  };
  const updateSession = (session) => {
    session.updated_at = new Date().toISOString();
    publish(session.id, 'session.updated', { session: summary(session) });
  };
  async function runtimeHealth() {
    return fetch(`${runtimeUrl}/health`, { signal: AbortSignal.timeout(3000) }).then(async (r) => {
      if (!r.ok) throw new Error();
      return r.json();
    }).catch(() => ({ healthy: false, mode: 'unavailable', model: 'Unavailable' }));
  }
  async function execute(session, content, assistant, controller) {
    let terminal = false;
    try {
      const response = await fetch(`${runtimeUrl}/runs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
        body: JSON.stringify({ runId: assistant.id, content, incident: session.incident, messages: session.messages.slice(-40), runtimeSessionId: session.runtimeSessionId }),
      });
      if (!response.ok) throw new Error('Runtime unavailable. Check the runtime service and retry.');
      for await (const { event, data } of readSse(response.body)) {
        if (event === 'run.context') {
          const changed = session.execution?.mode !== data.mode;
          session.execution = data;
          if (changed) {
            session.evidence = [];
            session.timeline = [];
            publish(session.id, 'evidence.collected', { evidence: [], timeline: [] });
          }
          updateSession(session);
        }
        if (event === 'runtime.session') { session.runtimeSessionId = data.id; await persist(session); }
        if (event === 'message.delta') {
          assistant.content += data.delta;
          if (assistant.content.length > 1000000) throw new Error('Agent response exceeded the demo size limit.');
          publish(session.id, event, { id: assistant.id, delta: data.delta });
        }
        if (event === 'message.final') {
          assistant.content = data.content;
          publish(session.id, 'message.updated', { message: assistant });
        }
        if (event === 'tool.updated') {
          data.message_id = assistant.id;
          if (data.diagnostic !== false && session.status === 'responding') {
            session.status = 'investigating';
            session.run_kind = 'investigation';
            updateSession(session);
          }
          const index = session.tools.findIndex((t) => t.id === data.id);
          if (index < 0) session.tools.push(data);
          else session.tools[index] = data;
          publish(session.id, event, data);
          if (data.status === 'completed') await persist(session);
        }
        if (event === 'evidence.collected') {
          Object.assign(session, data);
          publish(session.id, event, data);
        }
        if (event === 'run.failed') throw new Error(data.error);
        if (event === 'run.completed') {
          terminal = true;
          session.status = 'complete';
          if (session.run_kind === 'investigation') session.severity = data.severity || null;
          break;
        }
      }
      if (!terminal) throw new Error('Runtime stream disconnected before completion. Retry the investigation.');
    } catch (error) {
      session.status = controller.signal.aborted ? 'cancelled' : 'failed';
      session.error = controller.signal.aborted ? null : (error.name === 'TimeoutError' ? 'Investigation timed out. Retry or increase TRIAGE_RUN_TIMEOUT_MS.' : 'Investigation failed. Check the runtime and model configuration, then retry.');
    } finally {
      for (const tool of session.tools) if (['pending', 'running'].includes(tool.status)) {
        tool.status = 'cancelled';
        publish(session.id, 'tool.updated', tool);
      }
      assistant.complete = true;
      publish(session.id, 'message.updated', { message: assistant });
      updateSession(session);
      try { await persist(session); }
      catch { session.error = 'Unable to save this investigation. Check the API data volume.'; updateSession(session); }
      runs.delete(session.id);
    }
  }
  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && ['/health', '/global/health', '/api/health'].includes(url.pathname)) {
      const runtime = await runtimeHealth();
      return json(res, runtime.healthy ? 200 : 503, { healthy: runtime.healthy, service: 'api', runtime });
    }
    if (req.method === 'GET' && url.pathname === '/api/context') {
      try {
        const response = await fetch(`${runtimeUrl}/context`, { signal: AbortSignal.timeout(50000) });
        if (!response.ok) return json(res, 503, { error: 'Runtime context is unavailable' });
        return json(res, 200, await response.json());
      } catch { return json(res, 503, { error: 'Azure connection check timed out or the runtime is unavailable' }); }
    }
    if (url.pathname === '/api/sessions') {
      if (req.method === 'GET') return json(res, 200, { sessions: [...sessions.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(summary) });
      if (req.method === 'POST') {
        const input = await readJson(req);
        for (const key of ['description', 'customer', 'environment', 'workflow', 'title']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 1000)) return json(res, 400, { error: `Invalid ${key}` });
        if (input.environment !== undefined && !['staging', 'production', 'all'].includes(input.environment)) return json(res, 400, { error: 'Invalid environment' });
        const description = input.description?.trim() || 'ExampleCo staging report generation timeout around 10:00 UTC';
        const session = {
          id: randomUUID(), title: input.title || description.slice(0, 80), status: 'draft', severity: null,
          incident: { description, customer: input.customer || (/exampleco/i.test(description) ? 'ExampleCo' : 'Demo Customer'), environment: input.environment || (/prod/i.test(description) ? 'production' : 'staging'), workflow: input.workflow || 'Report generation' },
          messages: [], tools: [], evidence: [], timeline: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        await persist(session);
        sessions.set(session.id, session);
        return json(res, 201, { session: summary(session) });
      }
    }
    const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(messages|stream|cancel))?$/);
    if (!match) return json(res, 404, { error: 'Not found' });
    const session = sessions.get(match[1]);
    if (!session) return json(res, 404, { error: 'Investigation not found' });
    if (!match[2] && req.method === 'GET') return json(res, 200, { session: summary(session), messages: session.messages, tools: session.tools, evidence: session.evidence, timeline: session.timeline });
    if (match[2] === 'stream' && req.method === 'GET') {
      startSse(res);
      if (!subscribers.has(session.id)) subscribers.set(session.id, new Set());
      subscribers.get(session.id).add(res);
      // Every connection starts with authoritative state, avoiding lost/duplicated tokens on reconnect.
      writeSse(res, 'snapshot', { session: summary(session), messages: session.messages, tools: session.tools, evidence: session.evidence, timeline: session.timeline });
      res.on('close', () => {
        subscribers.get(session.id)?.delete(res);
        if (!subscribers.get(session.id)?.size) subscribers.delete(session.id);
      });
      return;
    }
    if (match[2] === 'cancel' && req.method === 'POST') {
      const run = runs.get(session.id);
      run?.controller.abort();
      await run?.done;
      return json(res, 200, { session: summary(session) });
    }
    if (match[2] === 'messages') {
      if (req.method === 'GET') return json(res, 200, { messages: session.messages });
      if (req.method === 'POST') {
        const input = await readJson(req);
        if (typeof input.content !== 'string' || !input.content.trim() || input.content.length > 16000) return json(res, 400, { error: 'Message must contain 1–16000 characters' });
        if (input.environment !== undefined && !['staging', 'production', 'all'].includes(input.environment)) return json(res, 400, { error: 'Invalid environment' });
        if (runs.has(session.id) || ['responding', 'investigating'].includes(session.status)) return json(res, 409, { error: 'A response is already running' });
        if (session.messages.length >= 200) return json(res, 400, { error: 'Start a new investigation to continue' });
        session.status = 'responding';
        session.run_kind = 'conversation';
        session.error = null;
        if (input.environment !== undefined) session.incident.environment = input.environment;
        const content = input.content.trim();
        const user = { id: randomUUID(), role: 'user', content, created_at: new Date().toISOString(), complete: true };
        const assistant = { id: randomUUID(), role: 'assistant', content: '', created_at: new Date().toISOString(), complete: false };
        session.active_message_id = assistant.id;
        session.messages.push(user, assistant);
        const controller = new AbortController();
        const run = { controller };
        runs.set(session.id, run);
        try { await persist(session); }
        catch (error) { runs.delete(session.id); session.status = 'failed'; throw error; }
        publish(session.id, 'message.updated', { message: user });
        publish(session.id, 'message.updated', { message: assistant });
        updateSession(session);
        run.done = execute(session, content, assistant, controller);
        return json(res, 202, { accepted: true, session: summary(session) });
      }
    }
    json(res, 405, { error: 'Method not allowed' });
  }
  const server = http.createServer((req, res) => route(req, res).catch((error) => {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'API request failed' });
    else res.end();
  }));
  server.shutdown = async () => {
    for (const run of runs.values()) run.controller.abort();
    await Promise.all([...runs.values()].map((run) => run.done));
    for (const set of subscribers.values()) for (const res of set) res.end();
    await Promise.all([...writes.values()].map((p) => p.catch(() => {})));
    server.close();
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await createApi();
  server.listen(Number(process.env.PORT || 7071), '0.0.0.0', () => console.log('Triage API ready'));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => server.shutdown());
}
