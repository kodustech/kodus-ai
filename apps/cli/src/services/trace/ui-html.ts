/**
 * The whole app, inlined. Two views: a session list and a session detail.
 *
 * Self-contained on purpose — no CDN, no fonts, no analytics. It reads the
 * local store through this process and makes no other network call.
 *
 * The visual tokens mirror the Kodus product shell in apps/web/src/app/globals.css
 * so the local-only utility still feels like part of the same product.
 */
export function renderTraceUiHtml(): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Kodus Trace</title>
<style>
:root {
  --bg: #101019;
  --surface: #181825;
  --surface-raised: #202032;
  --surface-active: #28283d;
  --border: #30304b;
  --border-strong: #3d3d5c;
  --text: #f3f3f7;
  --text-secondary: #cdcddf;
  --text-muted: #9292ad;
  --accent: #f8b76d;
  --accent-hover: #ffca8a;
  --accent-dark: #443024;
  --accent-soft: rgba(248, 183, 109, 0.1);
  --secondary: #c9bbf2;
  --secondary-dark: #312b4b;
  --danger: #fa5867;
  --success: #42be65;
  --code: #13131e;
  --focus: rgba(248, 183, 109, 0.35);
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { min-height: 100%; background: var(--bg); }
body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 "DM Sans", Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}
button, a { font: inherit; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.shell-header {
  height: 64px;
  border-bottom: 2px solid var(--accent-dark);
  background: var(--surface);
  display: flex;
  align-items: center;
  padding: 0 24px;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  text-decoration: none;
  flex: 0 0 auto;
}
.brand-mark { width: 30px; height: 30px; display: block; }
.brand-word { font-size: 21px; font-weight: 750; letter-spacing: -0.045em; }
.product-name {
  margin-left: 18px;
  padding-left: 18px;
  border-left: 1px solid var(--border);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
}
.local-indicator {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.local-indicator::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 3px rgba(66, 190, 101, 0.12);
}
.page { max-width: 1240px; margin: 0 auto; padding: 42px 32px 64px; }
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
.eyebrow {
  margin: 0 0 7px;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
h1, h2, h3, p { margin-top: 0; }
.page-heading h1 { margin-bottom: 7px; font-size: 28px; line-height: 1.2; letter-spacing: -0.035em; }
.page-heading p { max-width: 68ch; margin-bottom: 0; color: var(--text-muted); font-size: 13px; }
.summary {
  display: flex;
  align-items: center;
  gap: 22px;
  flex: 0 0 auto;
  padding: 10px 0;
}
.summary-item { min-width: 54px; }
.summary-value { display: block; color: var(--text); font-size: 17px; font-weight: 700; line-height: 1.1; }
.summary-label { display: block; margin-top: 4px; color: var(--text-muted); font-size: 11px; }
.summary-rule { width: 1px; height: 28px; background: var(--border); }
.panel { overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
.panel-bar {
  min-height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.panel-title { font-size: 12px; font-weight: 650; color: var(--text-secondary); }
.panel-meta { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-muted); }
.table-wrap { overflow-x: auto; }
table { width: 100%; min-width: 780px; border-collapse: collapse; }
th, td { text-align: left; border-bottom: 1px solid var(--border); }
th {
  height: 42px;
  padding: 0 16px;
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}
td { padding: 14px 16px; color: var(--text-secondary); font-size: 12px; vertical-align: middle; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: background 160ms cubic-bezier(0.25, 1, 0.5, 1); }
tbody tr:hover { background: var(--surface-raised); }
.session-link { display: inline-flex; align-items: center; gap: 9px; color: var(--text); font-weight: 650; text-decoration: none; }
.session-link::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.session-link:hover { color: var(--accent-hover); }
.muted-cell { color: var(--text-muted); }
.agent-badge, .badge {
  display: inline-flex;
  align-items: center;
  min-height: 23px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  padding: 2px 8px;
  color: var(--text-secondary);
  background: var(--surface-raised);
  font-size: 11px;
  white-space: nowrap;
}
.files { max-width: 340px; white-space: normal; color: var(--text-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.empty {
  min-height: 420px;
  display: grid;
  place-items: center;
  padding: 54px 24px;
  text-align: center;
}
.empty-content { max-width: 440px; }
.empty-mark {
  width: 52px;
  height: 52px;
  margin: 0 auto 22px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-raised);
  display: grid;
  place-items: center;
  color: var(--accent);
  font: 700 22px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.empty strong { display: block; margin-bottom: 8px; color: var(--text); font-size: 17px; }
.empty p { margin: 0 auto; color: var(--text-muted); font-size: 13px; }
code { border: 1px solid var(--border); border-radius: 4px; background: var(--code); padding: 2px 6px; color: var(--secondary); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.loading-line {
  height: 12px;
  border-radius: 4px;
  background: linear-gradient(90deg, var(--surface-raised), var(--surface-active), var(--surface-raised));
  background-size: 200% 100%;
  animation: loading 1.8s ease-in-out infinite;
}
@keyframes loading { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
.back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 22px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.back:hover { color: var(--accent); }
.detail-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
.detail-heading h1 { margin-bottom: 8px; font-size: 25px; line-height: 1.2; letter-spacing: -0.03em; }
.detail-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--text-muted); font-size: 12px; }
.section { margin-top: 30px; }
.section-heading { display: flex; align-items: baseline; gap: 9px; margin-bottom: 12px; }
.section-heading h2 { margin: 0; font-size: 14px; letter-spacing: -0.01em; }
.section-count { color: var(--text-muted); font-size: 11px; }
.decision-list { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
.decision { position: relative; padding: 16px 18px 16px 44px; border-bottom: 1px solid var(--border); }
.decision:last-child { border-bottom: 0; }
.decision-index {
  position: absolute;
  top: 17px;
  left: 16px;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  background: var(--secondary-dark);
  color: var(--secondary);
  font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.decision-title { margin-bottom: 5px; color: var(--text); font-size: 13px; font-weight: 650; }
.decision-why { max-width: 78ch; color: var(--text-muted); font-size: 12px; }
.decision-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.decision-meta .badge { border-color: var(--secondary-dark); color: var(--secondary); background: rgba(49, 43, 75, 0.52); }
.turn-list { display: grid; gap: 12px; }
.turn { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
.turn-header { min-height: 46px; padding: 0 16px; border-bottom: 1px solid var(--border); background: var(--surface-raised); display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.turn-title { margin: 0; font-size: 12px; font-weight: 650; }
.turn-time { color: var(--text-muted); font: 10px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
.turn-body { padding: 17px; }
.field + .field { margin-top: 18px; }
.field-label { margin-bottom: 7px; color: var(--text-muted); font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
pre {
  margin: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--code);
  padding: 13px 14px;
  overflow-x: auto;
  color: var(--text-secondary);
  font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.compact { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.compact li { padding: 9px 12px; border-bottom: 1px solid var(--border); color: var(--text-secondary); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.compact li:last-child { border-bottom: 0; }
.warn { margin: 0 0 18px; border: 1px solid rgba(242, 198, 49, 0.34); border-radius: 6px; background: rgba(242, 198, 49, 0.07); padding: 10px 12px; color: #f2d978; font-size: 12px; }
@media (max-width: 760px) {
  .shell-header { padding: 0 16px; }
  .product-name { margin-left: 12px; padding-left: 12px; }
  .local-indicator span { display: none; }
  .page { padding: 30px 16px 48px; }
  .page-heading, .detail-heading { align-items: flex-start; flex-direction: column; }
  .summary { width: 100%; justify-content: space-between; }
  .page-heading h1 { font-size: 24px; }
}
</style>
</head>
<body>
<header class="shell-header">
  <a class="brand" href="#/" aria-label="Kodus Trace home">
    <svg class="brand-mark" viewBox="0 0 30 30" fill="none" aria-hidden="true">
      <path d="M10.92 16.42 15.08 11.42 16.59 9.59c.01 0 1.57-1.86 3.46-4.13 1.89-2.28 3.54-4.25 3.68-4.39a4.45 4.45 0 0 1 2.83-1.01c1.36.15 2.43 1.01 2.82 2.28.18.57.2 1.24.04 1.83-.15.58-.5 1.19-1.15 1.95-.25.3-7.31 8.79-7.39 8.89-.05.07-.05.07.24.4.15.19 1.27 1.5 2.48 2.94 5.72 6.77 5.27 6.22 5.5 6.67.6 1.14.55 2.45-.13 3.47a3.8 3.8 0 0 1-.88.89c-.6.41-1.19.6-1.9.6-.88 0-1.58-.28-2.3-.91-.26-.24-.9-.95-1.07-1.19-.33-.49-.21-1.19.26-1.55.39-.3.96-.32 1.36-.04.07.05.29.28.49.5.2.23.42.48.5.55.48.42 1.04.43 1.46.02.38-.36.42-.89.1-1.36-.11-.17-1.97-2.38-5.92-7.05-1.02-1.2-2.06-2.43-2.31-2.73-.54-.62-.6-.74-.61-1.11 0-.27.07-.49.2-.68.09-.12 7.47-9.01 8.14-9.8.58-.69.73-.98.71-1.37-.02-.35-.2-.63-.5-.79-.11-.06-.17-.07-.48-.07-.34 0-.37.01-.56.1-.11.06-.25.16-.31.22-.06.07-.83.99-1.72 2.06-5.31 6.4-16.77 20.14-16.93 20.3-.23.24-.41.36-.63.42-.48.14-1.05-.04-1.34-.43-.15-.2-.23-.43-.28-.75-.02-.16-.03-3.38-.02-9.5.01-8.89.01-9.26.06-9.43.18-.52.6-.83 1.12-.83.28 0 .49.07.8.28.45.3.66.53 2.44 2.63 1.98 2.34 3.02 3.61 3.1 3.78.06.14.07.22.07.45 0 .25-.01.3-.1.48-.12.26-.31.45-.57.57-.18.09-.23.1-.48.1-.24 0-.3-.02-.46-.09-.1-.05-.22-.12-.27-.16-.05-.04-.63-.72-1.29-1.51-.66-.79-1.4-1.68-1.65-1.97l-.45-.53-.01 3.2v6.42l4.16-4.99Z" fill="url(#logo-a)"/>
      <path d="M.24 4.23C.83 1.9 2.64.31 5.04.04a6.2 6.2 0 0 1 4.31 1.34c.3.26 4.33 4.83 6.56 7.43.36.43.66.78.67.78l-1.5 1.84-.12-.15c-.5-.61-3-3.48-6.47-7.44-.63-.72-.9-.95-1.36-1.18-1.32-.65-3.07-.31-3.96.77-.49.59-.73 1.24-.8 2.15-.05.71-.05 18.73 0 19.05.08.45.2.83.36 1.18.52 1.07 1.39 1.7 2.54 1.84 1.02.13 1.9-.18 2.76-.96.22-.21 1.23-1.38 2.97-3.47.74-.87 1.41-1.67 1.51-1.76.59-.59 1.59-.36 1.88.43.1.25.09.64-.03.96-.05.11-.47.64-1.3 1.62-1.45 1.73-2.64 3.13-3.02 3.56-1.32 1.47-3.11 2.21-4.9 2.02a7.17 7.17 0 0 1-2.45-.81 6.65 6.65 0 0 1-2.01-2.24 6.31 6.31 0 0 1-.66-2.65C-.01 23.61-.01 12.9.03 8.47c.02-3.51.02-3.49.21-4.24Z" fill="url(#logo-b)"/>
      <defs>
        <linearGradient id="logo-a" x1="29.5" y1="15" x2="4.4" y2="15.2" gradientUnits="userSpaceOnUse"><stop stop-color="#f59220"/><stop offset=".48" stop-color="#ef4c4b"/><stop offset=".69" stop-color="#6a57a4"/><stop offset="1" stop-color="#ef4c4b"/></linearGradient>
        <linearGradient id="logo-b" x1="16.6" y1="15" x2="0" y2="15" gradientUnits="userSpaceOnUse"><stop stop-color="#f59220"/><stop offset=".48" stop-color="#ef4c4b"/><stop offset=".65" stop-color="#6a57a4"/><stop offset="1" stop-color="#ef4c4b"/></linearGradient>
      </defs>
    </svg>
    <span class="brand-word">kodus</span>
  </a>
  <span class="product-name">Trace</span>
  <span class="local-indicator"><span>Local workspace</span></span>
</header>
<main class="page" id="app">
  <div class="page-heading"><div><p class="eyebrow">Developer workspace</p><h1>Trace sessions</h1><p>Loading the local decision history for this repository.</p></div></div>
  <div class="panel"><div class="panel-bar"><div class="loading-line" style="width:120px"></div></div><div class="empty" style="min-height:260px"><div class="loading-line" style="width:240px"></div></div></div>
</main>
<script>
const app = document.getElementById('app');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function agentName(value) {
  return ({ 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex' })[value] || value || 'Unknown';
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Request failed with status ' + res.status);
  return res.json();
}

function emptyState(title, copy, mark = '⌁') {
  return '<div class="empty"><div class="empty-content"><div class="empty-mark" aria-hidden="true">' + mark + '</div>' +
    '<strong>' + esc(title) + '</strong><p>' + copy + '</p></div></div>';
}

async function renderList() {
  const data = await getJson('/api/sessions');
  const sessions = data.sessions || [];
  const branchCount = new Set(sessions.map((s) => s.branch).filter(Boolean)).size;
  const turnCount = sessions.reduce((total, s) => total + (Number(s.turnCount) || 0), 0);

  const heading = '<div class="page-heading"><div><p class="eyebrow">Developer workspace</p>' +
    '<h1>Trace sessions</h1><p>Private agent context captured for this repository. Raw transcripts never leave this machine.</p></div>' +
    '<div class="summary" aria-label="Session summary">' +
      '<div class="summary-item"><span class="summary-value">' + sessions.length + '</span><span class="summary-label">sessions</span></div>' +
      '<span class="summary-rule"></span>' +
      '<div class="summary-item"><span class="summary-value">' + branchCount + '</span><span class="summary-label">branches</span></div>' +
      '<span class="summary-rule"></span>' +
      '<div class="summary-item"><span class="summary-value">' + turnCount + '</span><span class="summary-label">turns</span></div>' +
    '</div></div>';

  if (sessions.length === 0) {
    app.innerHTML = heading + '<div class="panel"><div class="panel-bar"><span class="panel-title">Recent activity</span><span class="panel-meta">local only</span></div>' +
      emptyState('No sessions captured yet', 'Run <code>kodus trace enable</code>, then start an agent session in this repository.', '&gt;_') + '</div>';
    return;
  }

  const rows = sessions.map((s) => \`
    <tr>
      <td><a class="session-link" href="#/session/\${encodeURIComponent(s.sessionId)}">\${esc(s.branch || 'Unknown branch')}</a></td>
      <td><span class="agent-badge">\${esc(agentName(s.agentType))}</span></td>
      <td>\${Number(s.turnCount) || 0}</td>
      <td class="files">\${esc((s.filesTouched || []).slice(0, 5).join(', ')) || 'No files recorded'}</td>
      <td class="muted-cell">\${fmtDate(s.startedAt || s.updatedAt)}</td>
    </tr>\`).join('');

  app.innerHTML = heading + \`<section class="panel" aria-labelledby="recent-title">
    <div class="panel-bar"><span class="panel-title" id="recent-title">Recent activity</span><span class="panel-meta">\${sessions.length} local record\${sessions.length === 1 ? '' : 's'}</span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Branch</th><th>Agent</th><th>Turns</th><th>Files touched</th><th>Captured</th></tr></thead>
      <tbody>\${rows}</tbody></table></div>
    </section>\`;
}

async function renderDetail(sessionId) {
  const data = await getJson('/api/sessions/' + encodeURIComponent(sessionId));
  const session = data.session;

  if (!session) {
    app.innerHTML = '<a class="back" href="#/">← All sessions</a><div class="panel">' +
      emptyState('Record not found', 'This session is no longer available in the local store.', '404') + '</div>';
    return;
  }

  const decisions = (data.decisions || []).map((d, index) => \`
    <article class="decision">
      <span class="decision-index">\${index + 1}</span>
      <div class="decision-title">\${esc(d.decision)}</div>
      \${d.rationale ? '<div class="decision-why">' + esc(d.rationale) + '</div>' : ''}
      <div class="decision-meta"><span class="badge">\${esc(String(d.type || '').replaceAll('_', ' '))}</span>\${(d.scope || []).map((scope) => '<span class="badge">' + esc(scope) + '</span>').join('')}</div>
    </article>\`).join('');

  const warn = session.corruptLines > 0
    ? '<p class="warn">' + session.corruptLines + ' unreadable line(s) were skipped. The available session data is shown below.</p>'
    : '';

  const turns = session.turns.map((t, i) => \`
    <article class="turn">
      <header class="turn-header"><h3 class="turn-title">Turn \${i + 1}</h3><time class="turn-time">\${fmtDate(t.startedAt || t.endedAt)}</time></header>
      <div class="turn-body">
        \${t.prompt ? '<div class="field"><div class="field-label">Prompt</div><pre>' + esc(t.prompt) + '</pre></div>' : ''}
        \${t.response ? '<div class="field"><div class="field-label">Response</div><pre>' + esc(t.response) + '</pre></div>' : ''}
        \${(t.toolCalls || []).length ? '<div class="field"><div class="field-label">Tool calls</div><ul class="compact">' +
          t.toolCalls.map((c) => '<li>' + esc(c.toolName) + (c.summary ? ' · ' + esc(c.summary) : '') + '</li>').join('') + '</ul></div>' : ''}
        \${(t.filesModified || []).length ? '<div class="field"><div class="field-label">Files modified</div><ul class="compact">' +
          t.filesModified.map((f) => '<li>' + esc(f.path) + ' (' + esc(f.action) + ')</li>').join('') + '</ul></div>' : ''}
      </div>
    </article>\`).join('');

  const decisionBlock = decisions
    ? '<section class="section"><div class="section-heading"><h2>Distilled decisions</h2><span class="section-count">' + data.decisions.length + ' from this session</span></div><div class="decision-list">' + decisions + '</div></section>'
    : '';

  app.innerHTML = '<a class="back" href="#/">← All sessions</a>' +
    '<div class="detail-heading"><div><p class="eyebrow">Session detail</p><h1>' + esc(session.branch || 'Unknown branch') + '</h1>' +
    '<div class="detail-meta"><span class="agent-badge">' + esc(agentName(session.agentType)) + '</span><span>' + session.turns.length + (session.turns.length === 1 ? ' turn' : ' turns') + '</span><span>·</span><span>' + fmtDate(session.startedAt) + '</span></div></div>' +
    '<span class="panel-meta">' + esc(sessionId) + '</span></div>' + warn + decisionBlock +
    '<section class="section"><div class="section-heading"><h2>Conversation trace</h2><span class="section-count">sanitized local transcript</span></div><div class="turn-list">' +
    (turns || '<div class="panel">' + emptyState('No turns recorded', 'This session ended before a turn completed.', '0') + '</div>') + '</div></section>';
}

async function route() {
  const hash = location.hash || '#/';
  try {
    const match = hash.match(/^#\\/session\\/(.+)$/);
    if (match) await renderDetail(decodeURIComponent(match[1]));
    else await renderList();
  } catch (error) {
    app.innerHTML = '<div class="page-heading"><div><p class="eyebrow">Developer workspace</p><h1>Kodus Trace</h1></div></div><div class="panel">' +
      emptyState('Could not load the local store', esc(error instanceof Error ? error.message : 'Unknown error'), '!') + '</div>';
  }
}

window.addEventListener('hashchange', route);
route();
</script>
</body>
</html>
`;
}
