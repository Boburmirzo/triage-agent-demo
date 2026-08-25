import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 7070);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const sessions = new Map();
const subscribers = new Map();

const seededEvidence = [
  {
    source: 'Azure account',
    detail: 'Connected to demo subscription datox-observability-demo using managed identity scope.',
  },
  {
    source: 'Application Insights',
    detail: '12 failed POST /api/reports/generate requests between 09:58 and 10:04 UTC. All share operation ID demo-op-7f3a.',
  },
  {
    source: 'Exceptions',
    detail: 'TimeoutError raised by ReportRenderService after dependency calls exceeded 30 seconds.',
  },
  {
    source: 'Dependencies',
    detail: 'PostgreSQL dependency latency increased from 120 ms p95 to 8.4 s p95 during the failure window.',
  },
  {
    source: 'Container Apps',
    detail: 'compliance-functions-staging had two restarts after memory pressure and was processing queued report jobs slowly.',
  },
  {
    source: 'Queue Storage',
    detail: 'report-generation queue depth rose from 3 to 187 messages and oldest visible message age reached 18 minutes.',
  },
  {
    source: 'Deployment metadata',
    detail: 'No new revision was activated during the incident window; deployment regression is less likely.',
  },
];

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(statusCode, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    severity: session.severity,
    incident: session.incident,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

function writeSse(res, eventName, payload) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function publish(sessionId, eventName, payload) {
  const set = subscribers.get(sessionId);
  if (!set) return;
  for (const res of set) writeSse(res, eventName, payload);
}

function addMessage(session, role, content) {
  const message = {
    id: randomUUID(),
    role,
    content,
    created_at: new Date().toISOString(),
  };
  session.messages.push(message);
  session.updated_at = message.created_at;
  return message;
}

function inferIncident(input = {}) {
  const description = String(input.description || input.content || '').trim();
  const environment = input.environment || (description.toLowerCase().includes('prod') ? 'production' : 'staging');
  const customer = input.customer || (description.toLowerCase().includes('centralis') ? 'Centralis' : 'Demo Customer');
  return {
    customer,
    environment,
    workflow: input.workflow || 'Report generation',
    description: description || 'Demo report generation timeout around 10:00 UTC.',
  };
}

function buildRca(session, userMessage) {
  const incident = session.incident;
  return `Summary\n\nThe demo triage agent found a report-generation timeout pattern for ${incident.customer} in ${incident.environment}. The strongest signal is downstream database latency combined with queue backlog and function restarts.\n\nAffected customer\n\n${incident.customer}\n\nAffected environment\n\n${incident.environment}\n\nAffected workflow\n\n${incident.workflow}\n\nSeverity\n\nHigh\n\nLikely root cause\n\nReport generation workers were unable to complete jobs within the timeout window because PostgreSQL dependency latency spiked while the worker app was under memory pressure. Queue depth increased as jobs retried, which amplified the delay. A deployment regression is less likely because no new revision was activated during the failure window.\n\nEvidence collected\n\n| Source | Demo evidence |\n| --- | --- |\n${seededEvidence.map((item) => `| ${item.source} | ${item.detail} |`).join('\n')}\n\nRecommended actions\n\n1. Check PostgreSQL slow query and connection metrics for the 09:55-10:10 UTC window.\n2. Inspect report-generation worker memory usage and increase memory or concurrency limits if pressure is confirmed.\n3. Drain or replay queued jobs after worker health stabilizes.\n4. Add an alert for report queue age above 5 minutes and p95 database latency above 2 seconds.\n5. Capture the operation ID demo-op-7f3a in the incident record for follow-up.\n\nConfidence level\n\nMedium-high. This is a deterministic demo RCA based on simulated observability evidence, not live Azure telemetry.\n\nOriginal user request\n\n${userMessage}`;
}

async function simulateInvestigation(sessionId, content) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.status = 'investigating';
  session.updated_at = new Date().toISOString();
  publish(sessionId, 'session.updated', { session: publicSession(session) });

  const steps = [
    ['tool.started', 'Verifying Azure context', 'az account show'],
    ['tool.completed', 'Azure context verified', 'Subscription datox-observability-demo'],
    ['tool.started', 'Querying Application Insights', 'requests | where timestamp between (...)'],
    ['tool.completed', 'Application Insights query complete', seededEvidence[1].detail],
    ['tool.started', 'Checking exceptions', 'exceptions | where operation_Id == demo-op-7f3a'],
    ['tool.completed', 'Exception evidence found', seededEvidence[2].detail],
    ['tool.started', 'Checking dependency latency', 'dependencies | summarize p95(duration)'],
    ['tool.completed', 'Dependency latency elevated', seededEvidence[3].detail],
    ['tool.started', 'Checking Container App health', 'az containerapp show --name compliance-functions-staging'],
    ['tool.completed', 'Container App pressure detected', seededEvidence[4].detail],
    ['tool.started', 'Checking queue depth', 'az storage message peek --queue-name report-generation'],
    ['tool.completed', 'Queue backlog confirmed', seededEvidence[5].detail],
    ['tool.started', 'Checking deployment metadata', 'az containerapp revision list'],
    ['tool.completed', 'No deployment regression signal', seededEvidence[6].detail],
  ];

  for (const [event, label, detail] of steps) {
    await new Promise((resolve) => setTimeout(resolve, 650));
    publish(sessionId, event, {
      id: randomUUID(),
      label,
      detail,
      created_at: new Date().toISOString(),
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 600));
  session.status = 'complete';
  session.severity = 'High';
  const message = addMessage(session, 'assistant', buildRca(session, content));
  publish(sessionId, 'message.created', { message });
  publish(sessionId, 'session.updated', { session: publicSession(session) });
}

async function handleCreateSession(req, res) {
  const input = await readJson(req);
  const incident = inferIncident(input);
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: input.title || `${incident.customer} / ${incident.environment} / ${incident.workflow}`,
    status: 'draft',
    severity: null,
    incident,
    messages: [],
    created_at: now,
    updated_at: now,
  };
  sessions.set(session.id, session);
  sendJson(res, 201, { session: publicSession(session) });
}

async function handleSendMessage(req, res, sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
  const input = await readJson(req);
  const content = String(input.content || '').trim();
  if (!content) return sendJson(res, 400, { error: 'MESSAGE_REQUIRED' });
  addMessage(session, 'user', content);
  sendJson(res, 202, { accepted: true, session: publicSession(session) });
  simulateInvestigation(sessionId, content).catch((error) => {
    session.status = 'failed';
    addMessage(session, 'assistant', `Summary\n\nDemo investigation failed.\n\nEvidence collected\n\n${error.message}\n\nConfidence level\n\nLow`);
    publish(sessionId, 'session.updated', { session: publicSession(session) });
  });
}

function handleStream(req, res, sessionId) {
  if (!sessions.has(sessionId)) return sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  writeSse(res, 'connected', { sessionId });
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  subscribers.get(sessionId).add(res);
  req.on('close', () => {
    subscribers.get(sessionId)?.delete(res);
    if (!subscribers.get(sessionId)?.size) subscribers.delete(sessionId);
  });
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  return 'application/octet-stream';
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolved = path.resolve(publicDir, `.${requested}`);
  if (!resolved.startsWith(publicDir)) return sendText(res, 403, 'Forbidden');
  try {
    await fs.access(resolved);
    res.writeHead(200, { 'content-type': contentType(resolved), 'cache-control': 'no-store' });
    createReadStream(resolved).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/global/health') {
    return sendJson(res, 200, { healthy: true, service: 'triage-agent-demo', mode: 'offline-simulation' });
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return sendJson(res, 200, { sessions: [...sessions.values()].map(publicSession).reverse() });
  }
  if (req.method === 'POST' && url.pathname === '/api/sessions') return handleCreateSession(req, res);

  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|stream))?$/);
  if (match?.[1] && !match[2] && req.method === 'GET') {
    const session = sessions.get(match[1]);
    return session ? sendJson(res, 200, { session: publicSession(session) }) : sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
  }
  if (match?.[1] && match[2] === 'messages' && req.method === 'GET') {
    const session = sessions.get(match[1]);
    return session ? sendJson(res, 200, { messages: session.messages }) : sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
  }
  if (match?.[1] && match[2] === 'messages' && req.method === 'POST') return handleSendMessage(req, res, match[1]);
  if (match?.[1] && match[2] === 'stream' && req.method === 'GET') return handleStream(req, res, match[1]);
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  sendJson(res, 404, { error: 'NOT_FOUND' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => sendJson(res, 500, { error: 'DEMO_SERVER_ERROR', message: error.message }));
});

server.listen(port, host, () => {
  console.log(`Triage Agent Demo listening on http://${host}:${port}`);
});
