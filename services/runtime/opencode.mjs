import { readSse } from './lib/http.mjs';
import { conversationInstructions } from './conversation.mjs';

export function openCodeClient(env = process.env) {
  const base = env.OPENCODE_SERVER_URL || `http://127.0.0.1:${env.OPENCODE_PORT || 4097}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME || 'opencode'}:${env.OPENCODE_SERVER_PASSWORD || 'local-dev'}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  return async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, { ...options, headers, signal: options.signal || AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`OpenCode request failed (${response.status})`);
    return response;
  };
}

export async function investigateOpenCode(input, emit, signal, env = process.env) {
  const request = openCodeClient(env);
  // Keep OpenCode's conversation in its own persistent volume, paired with the API session.
  let sessionId = input.runtimeSessionId;
  if (!sessionId) {
    const response = await request('/session', { method: 'POST', body: JSON.stringify({ title: input.incident.description.slice(0, 100) }), signal });
    sessionId = (await response.json()).id;
    emit('runtime.session', { id: sessionId });
  }
  const path = `/session/${encodeURIComponent(sessionId)}`;
  const eventsController = new AbortController();
  const combined = AbortSignal.any([signal, eventsController.signal]);
  let completed = false;
  const texts = new Map();
  const toolStates = new Map();
  const roles = new Map();
  let streamFailure;
  try {
    // Subscribe before posting the prompt so even the first token/tool event is captured.
    const stream = await request('/event', { signal: combined });
    const consume = (async () => {
      for await (const { data: envelope } of readSse(stream.body)) {
        const event = envelope.payload || envelope;
        const p = event.properties || {};
        if ((p.sessionID || p.part?.sessionID || p.info?.sessionID) !== sessionId) continue;
        if (event.type === 'message.updated') {
          roles.set(p.info.id, p.info.role);
          if (p.info.error) throw new Error('The model could not complete this investigation. Check runtime configuration.');
        }
        if (event.type === 'session.error') throw new Error('The agent run failed. Check model availability and runtime configuration.');
        if (event.type === 'permission.asked' || event.type === 'question.asked') throw new Error('The agent requested interactive input unsupported by this headless runtime.');
        if (event.type === 'message.part.updated') {
          const part = p.part;
          if (roles.get(part.messageID) === 'user') continue;
          if (part.type === 'text') {
            const previous = texts.get(part.id) || '';
            const text = part.text || '';
            if (text.startsWith(previous) && text.length > previous.length) emit('message.delta', { delta: text.slice(previous.length) });
            texts.set(part.id, text);
          }
          if (part.type === 'tool') {
            const state = part.state;
            const signature = JSON.stringify(state);
            if (toolStates.get(part.id) === signature) continue;
            toolStates.set(part.id, signature);
            // Raw CLI output can contain sensitive Azure values. Only publish the tool's title/status.
            emit('tool.updated', {
              id: `${input.runId}-${part.id}`, label: part.tool,
              detail: state.status === 'error' ? 'Diagnostic tool failed' : (state.title || `${part.tool} diagnostic`),
              status: state.status,
              diagnostic: part.tool === 'bash',
              duration_ms: state.time?.end ? state.time.end - state.time.start : undefined,
            });
          }
        }
        if (event.type === 'message.part.delta' && p.field === 'text' && roles.get(p.messageID) !== 'user') {
          texts.set(p.partID, (texts.get(p.partID) || '') + p.delta);
          emit('message.delta', { delta: p.delta });
        }
      }
      if (!completed) throw new Error('Agent event stream disconnected. Retry the investigation.');
    })().catch((error) => {
      if (!eventsController.signal.aborted && !signal.aborted) {
        streamFailure = error;
        eventsController.abort();
      }
    });
    const response = await request(`${path}/message`, {
      method: 'POST', signal: combined,
      body: JSON.stringify({
        agent: env.OPENCODE_DEFAULT_AGENT || 'triage-agent',
        model: { providerID: env.OPENCODE_PROVIDER_ID || 'litellm', modelID: env.OPENCODE_MODEL || 'gpt-6-sol' },
        system: conversationInstructions(env, input.incident),
        parts: [{ type: 'text', text: input.content }],
      }),
    });
    const result = await response.json();
    if (result.info?.error || streamFailure) throw streamFailure || new Error('The model failed to complete the response.');
    // The final response is authoritative, including text emitted between event delivery and completion.
    const finalText = (result.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
    if (finalText) emit('message.final', { content: finalText });
    else if (![...texts.values()].some(Boolean)) throw new Error('The agent returned no response.');
    completed = true;
    eventsController.abort();
    await consume;
    emit('run.completed', {});
  } finally {
    eventsController.abort();
    if (!completed) await request(`${path}/abort`, { method: 'POST', body: '{}' }).catch(() => {});
  }
}
