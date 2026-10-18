import http from 'node:http';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { investigateDemo } from './demo.mjs';
import { investigateOpenCode, openCodeClient } from './opencode.mjs';
import { json, readJson, startSse, writeSse } from './lib/http.mjs';
import { contextReader } from './context.mjs';
import { modelProvider, publicModelProvider } from './model-provider.mjs';

export function createRuntime(env = process.env) {
  const mode = env.TRIAGE_MODE || 'demo';
  if (!['demo', 'opencode'].includes(mode)) throw new Error('TRIAGE_MODE must be demo or opencode');
  let lastInference = null;
  const provider = modelProvider(env);
  const context = contextReader(env, () => lastInference);
  return http.createServer(async (req, res) => {
    try {
      if (req.url === '/health' || req.url === '/global/health') {
        let healthy = true;
        if (mode === 'opencode') {
          healthy = await openCodeClient(env)('/global/health').then((r) => r.json()).then((v) => v.healthy === true).catch(() => false);
        }
        return json(res, healthy ? 200 : 503, { healthy, service: 'runtime', mode, liveAzure: env.TRIAGE_LIVE_AZURE_ENABLED === 'true', resourceGroup: env.AZURE_RESOURCE_GROUP || null, model: mode === 'demo' ? 'Deterministic demo' : provider.deployment, provider: mode === 'opencode' ? publicModelProvider(env, lastInference) : null });
      }
      if (req.url === '/context' && req.method === 'GET') return json(res, 200, await context());
      if (req.url !== '/runs' || req.method !== 'POST') return json(res, 404, { error: 'Not found' });
      const input = await readJson(req, 2 * 1024 * 1024);
      if (typeof input.content !== 'string' || !input.incident || !Array.isArray(input.messages)) return json(res, 400, { error: 'Invalid run' });
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Number(env.TRIAGE_RUN_TIMEOUT_MS || 600000))]);
      startSse(res);
      const emit = (event, data) => {
        if (mode === 'opencode' && ['run.completed', 'run.failed'].includes(event)) lastInference = { success: event === 'run.completed', at: new Date().toISOString() };
        writeSse(res, event, data);
      };
      try {
        if (mode === 'opencode') {
          // Chat must work without querying Azure. The diagnostic helper checks
          // Azure access only when the agent actually needs evidence for a request.
          emit('run.context', { mode: env.TRIAGE_LIVE_AZURE_ENABLED === 'true' ? 'live-azure' : 'opencode', resourceGroup: env.AZURE_RESOURCE_GROUP || null, subscriptionId: env.AZURE_SUBSCRIPTION_ID || null, provider: publicModelProvider(env) });
        }
        if (mode === 'demo') await investigateDemo(input, emit, signal);
        else await investigateOpenCode(input, emit, signal, env);
      } catch {
        emit('run.failed', { error: signal.aborted ? 'Investigation stopped or timed out.' : 'Agent execution failed. Check the Foundry deployment, authentication, and runtime configuration, then retry.' });
      } finally { res.end(); }
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Runtime request failed' });
      else res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let child;
  if (process.env.TRIAGE_MODE === 'opencode' && !process.env.OPENCODE_SERVER_URL) {
    child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', process.env.OPENCODE_PORT || '4097'], { stdio: 'inherit' });
    child.on('error', () => process.exit(1));
    child.on('exit', () => process.exit(1));
  }
  const server = createRuntime();
  server.listen(Number(process.env.PORT || 4096), '0.0.0.0', () => console.log('Triage runtime ready'));
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => {
    child?.kill('SIGTERM');
    server.close();
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
