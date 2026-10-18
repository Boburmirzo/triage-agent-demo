import { escapeHtml as esc, markdown } from './markdown.js';
import { filterResources, workloadPrompt } from './scope.js';

const $ = (id) => document.getElementById(id);
const state = { sessions: [], session: null, messages: [], tools: [], evidence: [], timeline: [], tab: 'trace', pending: false, health: null, context: null, connected: false, error: '', filter: '' };
let stream;
let revision = 0;
let renderFrame;
const messageNodes = new Map();
const formatTime = (date) => new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const busy = () => state.pending || ['responding', 'investigating'].includes(state.session?.status);
const liveAzure = () => !!state.health?.runtime?.liveAzure && !!state.health?.runtime?.resourceGroup;
const environment = () => $('environment').value;
const scopedResources = () => filterResources(state.context?.azure?.resources || [], environment());
const announce = (text) => { $('announcement').textContent = text; };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Workspace request failed. Please retry.');
  return body;
}

function putSession(session) {
  const index = state.sessions.findIndex((s) => s.id === session.id);
  if (index < 0) state.sessions.unshift(session);
  else state.sessions[index] = session;
}

function putMessage(message) {
  const index = state.messages.findIndex((m) => m.id === message.id);
  if (index < 0) state.messages.push(message);
  else state.messages[index] = message;
}

function renderSessions() {
  $('session-count').textContent = state.sessions.length;
  const sessions = state.sessions.filter((s) => s.title.toLowerCase().includes(state.filter.toLowerCase()));
  $('sessions').innerHTML = sessions.length ? sessions.map((s) => `<button class="session ${s.id === state.session?.id ? 'active' : ''}" data-session="${esc(s.id)}" ${s.id === state.session?.id ? 'aria-current="true"' : ''}><span class="session-symbol">${s.status === 'complete' ? '✓' : '◌'}</span><span><strong>${esc(s.title)}</strong><small>${esc(s.incident.environment)} · ${esc(s.status)}</small></span></button>`).join('') : `<p class="empty-history">${state.filter ? 'No matching investigations.' : 'A quieter on-call starts here.<br>Your investigations will appear here.'}</p>`;
}

function renderMessages() {
  const chat = $('chat');
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 100;
  $('welcome').hidden = !!state.messages.length;
  for (const message of state.messages) {
    let node = messageNodes.get(message.id);
    if (!node) {
      node = document.createElement('article');
      node.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
      node.innerHTML = `<div class="message-heading"><span class="message-avatar">${message.role === 'user' ? 'Y' : '⌁'}</span><span>${message.role === 'user' ? 'You' : 'Triage agent'}</span><time>${esc(formatTime(message.created_at))}</time></div><div class="message-body ${message.role === 'assistant' ? 'markdown' : ''}"></div>`;
      $('messages').append(node);
      messageNodes.set(message.id, node);
    }
    const signature = `${message.complete}:${message.content}`;
    if (node._signature !== signature) {
      const body = node.querySelector('.message-body');
      if (message.role === 'user') body.textContent = message.content;
      else body.innerHTML = markdown(message.content || (message.complete ? '_No answer produced._' : '')) + (!message.complete && message.content ? '<span class="stream-cursor" aria-label="Streaming response"></span>' : '');
      node._signature = signature;
    }
  }
  const runningTool = [...state.tools].reverse().find((t) => ['running', 'pending'].includes(t.status) && (!state.session?.active_message_id || t.message_id === state.session.active_message_id));
  const activityText = runningTool ? `${runningTool.diagnostic === false ? 'Using' : 'Checking'} ${runningTool.label}…` : state.session?.status === 'investigating' ? 'Correlating the signals…' : 'Preparing a response…';
  $('activity').hidden = !busy();
  if ($('activity').dataset.label !== activityText) {
    $('activity').innerHTML = `<span class="activity-dot"></span>${esc(activityText)}`;
    $('activity').dataset.label = activityText;
  }
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function emptyContext() {
  if (liveAzure()) {
    const azure = state.context?.azure;
    return `<div class="radar" aria-hidden="true"><span class="radar-ring"></span><span class="radar-ring inner"></span><span class="radar-center">⌁</span></div><div class="context-empty-title">${esc(state.health.runtime.resourceGroup)}</div><p class="context-empty-text">${azure?.connected ? `${scopedResources().length} resources match ${esc(environment())}. Start an investigation to collect real diagnostic evidence.` : 'Waiting for Azure resource discovery.'}</p><p class="context-description">Workload checks correlate application, container, and database signals. Shared dependencies are resolved separately.</p>`;
  }
  const live = state.health?.runtime?.mode === 'opencode';
  return `<div class="radar" aria-hidden="true"><span class="radar-ring"></span><span class="radar-ring inner"></span><span class="radar-center">⌁</span><span class="radar-point"></span></div><div class="context-empty-title">Every signal tells a story.</div><p class="context-empty-text">Start an investigation to watch your agent connect the evidence, one step at a time.</p><div class="source-list"><p class="context-eyebrow">${live ? 'DIAGNOSTIC SURFACES' : 'DEMO EVIDENCE SOURCES'}</p>${[['⌁', 'Application Insights', 'Requests, exceptions & dependencies'], ['⬡', 'Container Apps', 'Worker health & revision history'], ['▤', 'Queue Storage', 'Backlog & message age']].map(([symbol, name, detail]) => `<div class="source"><span class="source-symbol">${symbol}</span><div><strong>${name}</strong><small>${detail}</small></div><span>${live ? 'TOOL' : 'DEMO'}</span></div>`).join('')}</div>`;
}

function renderContext() {
  $('tool-count').textContent = state.tools.length;
  $('evidence-count').textContent = state.evidence.length;
  for (const button of document.querySelectorAll('[data-tab]')) {
    button.classList.toggle('active', button.dataset.tab === state.tab);
    button.setAttribute('aria-selected', String(button.dataset.tab === state.tab));
  }
  $('context-content').setAttribute('aria-labelledby', `${state.tab}-tab`);
  $('resource-search').hidden = state.tab !== 'resources';
  if (state.tab === 'resources') {
    const filter = $('resource-filter').value.toLowerCase();
    const resources = scopedResources();
    const matches = resources.filter((r) => `${r.name} ${r.type} ${r.location}`.toLowerCase().includes(filter));
    $('context-content').innerHTML = `<p class="context-eyebrow">${matches.length} OF ${resources.length} RESOURCES · ${esc(environment().toUpperCase())}</p><p class="context-description">Name-filtered discovery. Investigations also follow confirmed shared log workspaces and database dependencies.</p>${matches.map((r) => `<button class="resource-row" data-resource="${esc(r.id)}"><strong>${esc(r.name)}</strong><small>${esc(r.type)}<br>${esc(r.location)}</small><span>Investigate workload ↗</span></button>`).join('') || '<p class="context-description">No matching resources.</p>'}`;
    return;
  }
  if (state.tab === 'trace') {
    if (!state.tools.length) { $('context-content').innerHTML = emptyContext(); return; }
    const open = new Set([...$('context-content').querySelectorAll('details[open]')].map((d) => d.dataset.tool));
    $('context-content').innerHTML = `<p class="context-eyebrow">${busy() ? 'FOLLOWING THE SIGNALS' : 'INVESTIGATION TRACE'}</p>${state.session?.status === 'complete' ? `<div class="context-summary">✓ Investigation complete<br>${state.tools.filter((t) => t.status === 'completed').length} diagnostic steps completed${state.session.severity ? ` · ${esc(state.session.severity)} severity` : ''}</div>` : ''}${state.tools.map((t) => `<div class="trace-item ${esc(t.status)}"><span class="trace-node">${t.status === 'completed' ? '✓' : t.status === 'error' ? '!' : '·'}</span><div class="trace-title"><strong>${esc(t.label)}</strong><small>${t.duration_ms !== undefined ? `${(t.duration_ms / 1000).toFixed(1)}s` : esc(t.status)}</small></div><p>${esc(t.detail)}</p>${t.evidence ? `<details data-tool="${esc(t.id)}" ${open.has(t.id) ? 'open' : ''}><summary>View source reference</summary><p><code>${esc(t.evidence.resource)}<br>${esc(t.evidence.correlation_id)}</code></p></details>` : ''}</div>`).join('')}`;
  } else {
    $('context-content').innerHTML = state.evidence.length ? `<p class="context-eyebrow">SEEDED EVIDENCE · AUG 12, 2026</p>${state.evidence.map((e, i) => `<article class="evidence-card"><h3>${String(i + 1).padStart(2, '0')} / ${esc(e.source)}</h3><p>${esc(e.finding)}</p><code>${esc(e.resource)}</code><small>↳ ${esc(e.correlation_id)}</small></article>`).join('')}<p class="context-eyebrow">INCIDENT TIMELINE · UTC</p>${state.timeline.map((t) => `<div class="timeline-item"><time>${esc(t.timestamp_utc.slice(11, 19))}</time><span>${esc(t.observation)}</span></div>`).join('')}` : `<p class="context-eyebrow">EVIDENCE EXPLORER</p><p class="context-description">${state.health?.runtime?.mode === 'opencode' ? 'OpenCode tool activity appears in Agent activity. Evidence and citations are included in the agent’s streamed response.' : 'Verified demo findings and correlation IDs will appear here as the investigation progresses.'}</p>`;
  }
}

function render() {
  renderFrame = null;
  const running = busy();
  $('send').hidden = running;
  $('stop').hidden = !running;
  $('stop').disabled = state.pending;
  $('send').disabled = !$('prompt').value.trim() || state.pending;
  $('environment').disabled = running;
  $('page-title').textContent = state.session?.title || 'New investigation';
  $('run-status').textContent = running ? (state.session?.status === 'investigating' ? 'INVESTIGATION IN PROGRESS' : 'RESPONDING') : state.session?.status === 'complete' && state.session?.run_kind === 'conversation' ? 'RESPONSE COMPLETE' : state.session?.status?.toUpperCase() || 'READY WHEN YOU ARE';
  $('export').disabled = !state.messages.length;
  const error = state.error || state.session?.error;
  $('error').textContent = error || '';
  $('error').hidden = !error;
  renderSessions();
  renderMessages();
  renderContext();
}

function scheduleRender() { if (!renderFrame) renderFrame = requestAnimationFrame(render); }

function connection(connected) {
  state.connected = connected;
  $('connection-dot').classList.toggle('offline', !connected);
  $('connection').textContent = connected ? (state.session ? 'Event stream connected' : 'Workspace connected') : 'Reconnecting to workspace…';
}

function connectStream(id) {
  stream?.close();
  const source = new EventSource(`/api/sessions/${id}/stream`);
  stream = source;
  const listen = (name, handler) => source.addEventListener(name, (event) => {
    if (state.session?.id !== id || stream !== source) return;
    handler(JSON.parse(event.data));
    scheduleRender();
  });
  source.onopen = () => { if (stream === source) connection(true); };
  source.onerror = () => { if (stream === source) connection(false); };
  listen('snapshot', (snapshot) => {
    Object.assign(state, snapshot);
    putSession(snapshot.session);
    // A reconnect snapshot can replace text previously delivered as deltas.
    for (const [key, node] of messageNodes) if (!state.messages.some((m) => m.id === key)) { node.remove(); messageNodes.delete(key); }
  });
  listen('message.updated', ({ message }) => putMessage(message));
  listen('message.delta', ({ id, delta }) => {
    const message = state.messages.find((m) => m.id === id);
    if (message) message.content += delta;
  });
  listen('tool.updated', (tool) => {
    const index = state.tools.findIndex((t) => t.id === tool.id);
    if (index < 0) state.tools.push(tool);
    else state.tools[index] = tool;
  });
  listen('evidence.collected', (data) => Object.assign(state, data));
  listen('session.updated', ({ session }) => {
    state.session = session;
    putSession(session);
    if (!['responding', 'investigating'].includes(session.status)) announce(`${session.run_kind === 'conversation' ? 'Response' : 'Investigation'} ${session.status}`);
  });
}

function clearConversation() {
  state.messages = []; state.tools = []; state.evidence = []; state.timeline = [];
  messageNodes.clear();
  $('messages').replaceChildren();
}

function newInvestigation() {
  if (state.pending) return;
  revision++;
  stream?.close(); stream = null;
  state.session = null; state.error = '';
  clearConversation();
  history.replaceState(null, '', location.pathname);
  $('prompt').value = '';
  connection(!!state.health?.healthy);
  render();
  $('prompt').focus();
  $('chat').scrollTop = 0;
  closeSidebar();
}

async function selectSession(id) {
  const current = ++revision;
  stream?.close(); stream = null;
  state.error = '';
  try {
    const snapshot = await api(`/api/sessions/${id}`);
    if (current !== revision) return;
    clearConversation();
    Object.assign(state, snapshot);
    $('environment').value = snapshot.session.incident.environment;
    renderScope();
    history.replaceState(null, '', `#${id}`);
    connectStream(id);
    render();
    $('chat').scrollTop = $('chat').scrollHeight;
    closeSidebar();
  } catch (error) { if (current === revision) { state.error = error.message; render(); } }
}

async function sendMessage(event) {
  event?.preventDefault();
  const content = $('prompt').value.trim();
  if (!content || busy()) return;
  state.pending = true; state.error = '';
  const current = revision;
  render();
  try {
    let session = state.session;
    if (!session) {
      const payload = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ description: content.slice(0, 1000), environment: $('environment').value, ...(liveAzure() ? { customer: state.health.runtime.resourceGroup, workflow: 'Azure resource investigation' } : {}) }) });
      session = payload.session;
      putSession(session);
      state.session = session;
      history.replaceState(null, '', `#${session.id}`);
      connectStream(session.id);
    }
    const accepted = await api(`/api/sessions/${session.id}/messages`, { method: 'POST', body: JSON.stringify({ content, environment: environment() }) });
    if (revision !== current) return;
    state.session = accepted.session;
    putSession(accepted.session);
    // Re-subscribe for an atomic snapshot followed by deltas, never mixing a stale GET with events.
    connectStream(session.id);
    $('prompt').value = '';
    $('prompt').style.height = '';
    announce('Message sent');
    render();
    $('chat').scrollTop = $('chat').scrollHeight;
  } catch (error) { if (revision === current) state.error = error.message; }
  finally { state.pending = false; render(); }
}

function closeSidebar() { $('sidebar').classList.remove('open'); $('menu-toggle').setAttribute('aria-expanded', 'false'); }

$('composer').addEventListener('submit', sendMessage);
$('prompt').addEventListener('input', () => {
  $('send').disabled = !$('prompt').value.trim();
  $('prompt').style.height = 'auto';
  $('prompt').style.height = `${Math.min($('prompt').scrollHeight, 180)}px`;
});
$('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
});
$('new-session').addEventListener('click', newInvestigation);
$('search').addEventListener('input', (event) => { state.filter = event.target.value; renderSessions(); });
$('sessions').addEventListener('click', (event) => { const button = event.target.closest('[data-session]'); if (button && !state.pending) selectSession(button.dataset.session); });
document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => {
  $('prompt').value = button.dataset.prompt;
  $('send').disabled = false;
  $('prompt').focus();
}));
document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => { state.tab = button.dataset.tab; renderContext(); }));
$('resource-filter').addEventListener('input', renderContext);
$('environment').addEventListener('change', () => { renderScope(); renderContext(); });
$('context-content').addEventListener('click', (event) => {
  const resource = event.target.closest('[data-resource]');
  if (!resource) return;
  $('prompt').value = workloadPrompt(resource.dataset.resource, environment());
  $('send').disabled = false;
  $('prompt').focus();
  if (window.innerWidth <= 1200) { $('inspector').classList.remove('open'); $('panel-toggle').setAttribute('aria-expanded', 'false'); }
});
$('stop').addEventListener('click', async () => {
  const id = state.session?.id;
  if (!id) return;
  try { await api(`/api/sessions/${id}/cancel`, { method: 'POST', body: '{}' }); }
  catch (error) { state.error = error.message; render(); }
});
$('export').addEventListener('click', () => {
  const content = `# ${state.session.title}\n\nStatus: ${state.session.status}\n\n${state.messages.map((m) => `## ${m.role === 'user' ? 'You' : 'Triage agent'}\n\n${m.content}`).join('\n\n')}`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
  const link = document.createElement('a'); link.href = url; link.download = `signal-${state.session.id}.md`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce('Investigation exported');
});
for (const [button, panel] of [['menu-toggle', 'sidebar'], ['panel-toggle', 'inspector']]) $(button).addEventListener('click', () => {
  $(panel).classList.toggle('open');
  $(button).setAttribute('aria-expanded', String($(panel).classList.contains('open')));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { closeSidebar(); $('inspector').classList.remove('open'); $('panel-toggle').setAttribute('aria-expanded', 'false'); }
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); newInvestigation(); }
});

async function loadHealth() {
  try {
    state.health = await api('/api/health');
    const runtime = state.health.runtime;
    const demo = runtime.mode === 'demo';
    $('mode').textContent = demo ? 'DEMO MODE' : liveAzure() ? 'LIVE AZURE' : 'OPENCODE';
    $('mode').title = runtime.model;
    $('mode-note').textContent = demo ? 'Simulated evidence · No cloud credentials needed.' : liveAzure() ? `${runtime.resourceGroup} · ${runtime.model} · Read-only diagnostics` : runtime.liveAzure ? 'Live Azure enabled · Read-only, on request.' : 'OpenCode + LiteLLM · Seeded Azure evidence.';
    $('demo-preview').hidden = liveAzure();
    $('live-preview').hidden = !liveAzure();
    $('resources-tab').hidden = !liveAzure();
    if (liveAzure()) {
      $('live-group').textContent = runtime.resourceGroup;
      document.querySelector('.intro').textContent = `Investigate real Azure resources in ${runtime.resourceGroup}. Discover the scope, follow the telemetry, and inspect the evidence.`;
      document.querySelector('.profile strong').textContent = 'Azure workspace';
      renderScope();
    }
    if (!stream) connection(true);
    renderContext();
  } catch {
    $('mode').textContent = 'OFFLINE';
    connection(false);
  }
}

async function loadLiveContext() {
  if (!liveAzure()) return;
  try {
    const first = !state.context;
    state.context = await api('/api/context');
    const { azure, provider } = state.context;
    renderScope();
    $('inventory-time').textContent = azure?.checkedAt ? `Checked ${formatTime(azure.checkedAt)}` : 'Not connected';
    $('azure-status').textContent = azure?.error || provider?.error || `${azure.subscription} · Azure + GPT-6 Sol connected`;
    $('azure-dot').classList.toggle('offline', !azure?.connected);
    $('mode').classList.toggle('live', !!azure?.connected && !!provider?.connected);
    if (first && !state.session) state.tab = 'resources';
    renderContext();
  } catch (error) { $('azure-status').textContent = error.message; }
}

function renderScope() {
  if (!liveAzure()) return;
  const resources = scopedResources();
  const connected = state.context?.azure?.connected;
  $('resource-total').textContent = connected ? resources.length : '—';
  $('type-total').textContent = connected ? new Set(resources.map((r) => r.type.toLowerCase())).size : '—';
  $('region-total').textContent = connected ? new Set(resources.map((r) => r.location)).size : '—';
  $('resource-count').textContent = resources.length;
  $('live-group').textContent = `${state.health.runtime.resourceGroup} / ${environment()}`;
  const scope = `${environment()} resources in ${state.health.runtime.resourceGroup}`;
  const prompts = [
    ['Discover selected resources', 'Filter names for the selected environment.', `Discover ${scope} using inventory --environment ${environment()}. Summarize resource types and monitoring coverage. Inventory only; do not query workload telemetry.`],
    ['Investigate the backend', 'Correlate application, container, and DB logs.', `Investigate the backend workload among ${scope} over the last hour. Use workload-check with --environment ${environment()} to correlate App Insights exceptions/traces, Container App console/system logs and runtime metrics, and confirmed database metrics/logs. If App Insights is empty, continue to the host logs. Label shared dependencies, root-cause confidence, and coverage gaps.`],
    ['Review recent failures', 'Follow errors across the application stack.', `Review recent failures affecting ${scope} over the last hour. Correlate activity history with application errors, container logs and confirmed database signals. Use --environment ${environment()} for every helper command. Report actual evidence and gaps without inspecting unrelated environments.`],
  ];
  document.querySelectorAll('[data-prompt]').forEach((button, i) => {
    button.querySelector('strong').textContent = prompts[i][0];
    button.querySelector('small').textContent = prompts[i][1];
    button.dataset.prompt = prompts[i][2];
  });
}

render();
await loadHealth();
loadLiveContext();
try {
  state.sessions = (await api('/api/sessions')).sessions;
  const id = location.hash.slice(1);
  if (state.sessions.some((s) => s.id === id)) await selectSession(id);
  else renderSessions();
} catch (error) { state.error = error.message; render(); }
setInterval(loadHealth, 20000);
setInterval(loadLiveContext, 60000);
