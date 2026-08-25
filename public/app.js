const state = {
  sessions: [],
  activeId: null,
  messages: [],
  tools: [],
  sending: false,
  eventStatus: '',
  draft: {
    customer: 'Centralis',
    environment: 'staging',
    workflow: 'Report generation',
    description: 'Centralis staging report failed with timeout around 10:00 UTC. Please investigate.',
  },
  input: 'Centralis staging report failed with timeout around 10:00 UTC. Please investigate.',
};

const app = document.getElementById('app');
let stream = null;

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function renderMarkdown(text) {
  const lines = String(text || '').split(/\r?\n/);
  const html = [];
  let table = [];
  let list = [];
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ol>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`);
    list = [];
  };
  const flushTable = () => {
    if (table.length < 2) {
      html.push(...table.map((line) => `<p>${escapeHtml(line)}</p>`));
      table = [];
      return;
    }
    const rows = table.map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => escapeHtml(cell.trim())));
    const header = rows[0];
    const body = rows.slice(2);
    html.push(`<table><thead><tr>${header.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    table = [];
  };

  for (const line of lines) {
    if (/^\s*\|.+\|\s*$/.test(line)) {
      flushList();
      table.push(line);
      continue;
    }
    if (table.length) flushTable();
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) {
      list.push(numbered[1]);
      continue;
    }
    if (!line.trim()) {
      flushList();
      continue;
    }
    flushList();
    if (/^[A-Z][A-Za-z ]+$/.test(line.trim()) && line.trim().length < 40) html.push(`<h3>${escapeHtml(line.trim())}</h3>`);
    else html.push(`<p>${escapeHtml(line)}</p>`);
  }
  flushList();
  if (table.length) flushTable();
  return html.join('');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || payload.error || `Request failed: ${response.status}`);
  return payload;
}

async function loadSessions() {
  const payload = await api('/api/sessions');
  state.sessions = payload.sessions || [];
  if (!state.activeId && state.sessions[0]) state.activeId = state.sessions[0].id;
  if (state.activeId) await loadMessages(state.activeId, false);
  render();
}

async function loadMessages(sessionId, shouldRender = true) {
  const payload = await api(`/api/sessions/${sessionId}/messages`);
  state.messages = payload.messages || [];
  if (shouldRender) render();
}

function connectStream(sessionId) {
  if (stream) stream.close();
  state.tools = [];
  stream = new EventSource(`/api/sessions/${sessionId}/stream`);
  stream.addEventListener('tool.started', (event) => {
    const payload = JSON.parse(event.data);
    state.eventStatus = payload.label;
    state.tools.push({ ...payload, status: 'running' });
    render();
  });
  stream.addEventListener('tool.completed', (event) => {
    const payload = JSON.parse(event.data);
    state.eventStatus = payload.label;
    state.tools.push({ ...payload, status: 'complete' });
    render();
  });
  stream.addEventListener('message.created', async () => {
    await loadMessages(sessionId, false);
    state.sending = false;
    state.eventStatus = 'RCA complete';
    await loadSessions();
  });
  stream.addEventListener('session.updated', async (event) => {
    const payload = JSON.parse(event.data);
    state.sessions = state.sessions.map((session) => (session.id === payload.session.id ? payload.session : session));
    render();
  });
}

async function createDemoSession() {
  const payload = await api('/api/sessions', { method: 'POST', body: JSON.stringify(state.draft) });
  state.sessions = [payload.session, ...state.sessions.filter((session) => session.id !== payload.session.id)];
  state.activeId = payload.session.id;
  state.messages = [];
  connectStream(payload.session.id);
  render();
}

async function sendMessage() {
  const content = state.input.trim();
  if (!content) return;
  if (!state.activeId) await createDemoSession();
  state.sending = true;
  state.eventStatus = 'Starting investigation...';
  render();
  await api(`/api/sessions/${state.activeId}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
  await loadMessages(state.activeId, false);
  render();
}

function activeSession() {
  return state.sessions.find((session) => session.id === state.activeId) || null;
}

function renderSessionList() {
  if (!state.sessions.length) return '<p class="muted">No demo investigations yet.</p>';
  return state.sessions.map((session) => `<button class="session ${session.id === state.activeId ? 'active' : ''}" data-session="${session.id}"><strong>${escapeHtml(session.title)}</strong><span>${escapeHtml(session.status)}${session.severity ? ` · ${escapeHtml(session.severity)}` : ''}</span></button>`).join('');
}

function renderMessages() {
  if (!state.messages.length && !state.sending) {
    return `<div class="empty"><p class="kicker">Offline Azure Observability Agent Demo</p><h1>Turn an incident report into an evidence-backed RCA.</h1><p>Create a demo investigation, then send the sample prompt to watch simulated Azure diagnostics progress.</p></div>`;
  }
  const messages = state.messages.map((message) => `<div class="message ${message.role}"><div class="bubble markdown">${message.role === 'assistant' ? renderMarkdown(message.content) : escapeHtml(message.content)}</div></div>`).join('');
  const thinking = state.sending ? `<div class="message assistant"><div class="bubble"><strong>${escapeHtml(state.eventStatus || 'Investigating...')}</strong>${renderTools()}</div></div>` : '';
  return `<div class="messages">${messages}${thinking}</div>`;
}

function renderTools() {
  if (!state.tools.length) return '';
  return `<div class="tools">${state.tools.slice(-8).map((tool) => `<div class="tool ${tool.status}"><span>${tool.status === 'complete' ? '✓' : '…'}</span><div><strong>${escapeHtml(tool.label)}</strong><small>${escapeHtml(tool.detail)}</small></div></div>`).join('')}</div>`;
}

function render() {
  const session = activeSession();
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand"><div class="mark">AZ</div><div><strong>Observability Agent</strong><span>Demo triage workspace</span></div></div>
      <button class="primary" id="new-session">New demo investigation</button>
      <div class="session-list">${renderSessionList()}</div>
      <div class="note">Offline simulation. No Azure calls, no OpenCode calls, no credentials.</div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div><span>Active investigation</span><strong>${escapeHtml(session?.title || 'No session selected')}</strong></div>
        <div class="pill ${session?.status || 'draft'}">${escapeHtml(session?.status || 'draft')}</div>
      </header>
      <section class="chat">${renderMessages()}</section>
      <footer class="composer">
        <textarea id="prompt" rows="2" placeholder="Describe an incident...">${escapeHtml(state.input)}</textarea>
        <button class="send" id="send" ${state.sending ? 'disabled' : ''}>Investigate</button>
      </footer>
    </main>
  `;

  document.getElementById('new-session').onclick = createDemoSession;
  document.getElementById('send').onclick = sendMessage;
  document.getElementById('prompt').oninput = (event) => { state.input = event.target.value; };
  document.querySelectorAll('[data-session]').forEach((button) => {
    button.onclick = async () => {
      state.activeId = button.dataset.session;
      connectStream(state.activeId);
      await loadMessages(state.activeId);
    };
  });
}

await loadSessions();
if (!state.activeId) await createDemoSession();
