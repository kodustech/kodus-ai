/**
 * The whole app, inlined. Two views: a session list and a session detail.
 *
 * Self-contained on purpose — no CDN, no fonts, no analytics. It reads the
 * local store through this process and makes no other network call.
 */
export function renderTraceUiHtml(): string {
    return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kodus Trace</title>
<style>
:root {
  --bg: #fbfbfa;
  --surface: #ffffff;
  --border: #e4e4e1;
  --text: #1c1c1a;
  --muted: #6b6b66;
  --accent: #2f6f4f;
  --accent-soft: #e8f1ec;
  --code-bg: #f4f4f2;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17181a;
    --surface: #1f2023;
    --border: #34363a;
    --text: #ececea;
    --muted: #9a9a94;
    --accent: #8fd0ac;
    --accent-soft: #23302a;
    --code-bg: #26282c;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}
header {
  border-bottom: 1px solid var(--border);
  padding: 18px 24px;
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
header h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
header .sub { color: var(--muted); font-size: 13px; }
main { padding: 24px; max-width: 1100px; margin: 0 auto; }
.empty {
  border: 1px dashed var(--border);
  border-radius: 10px;
  padding: 48px 24px;
  text-align: center;
  color: var(--muted);
}
.empty strong { display: block; color: var(--text); margin-bottom: 6px; font-size: 16px; }
table { width: 100%; border-collapse: collapse; }
.table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; }
tbody tr:last-child td { border-bottom: none; }
tbody tr { cursor: pointer; }
tbody tr:hover { background: var(--accent-soft); }
td.files { white-space: normal; color: var(--muted); font-size: 13px; max-width: 340px; }
a.back { color: var(--accent); text-decoration: none; font-size: 13px; }
a.back:hover { text-decoration: underline; }
.turn {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 16px;
  margin-bottom: 14px;
}
.turn h3 { margin: 0 0 10px; font-size: 13px; color: var(--muted); font-weight: 600; }
.turn .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-top: 12px; }
pre {
  background: var(--code-bg);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 6px 0 0;
}
ul.compact { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
.badge {
  display: inline-block;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 12px;
  color: var(--muted);
  margin-right: 6px;
}
.decision { border-left: 3px solid var(--accent); padding-left: 12px; margin-bottom: 12px; }
.decision .why { color: var(--muted); font-size: 13px; }
.warn { color: var(--muted); font-size: 13px; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>Kodus Trace</h1>
  <span class="sub" id="subtitle">local session store</span>
</header>
<main id="app"><div class="empty">Loading…</div></main>
<script>
const app = document.getElementById('app');
const subtitle = document.getElementById('subtitle');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleString();
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function renderList() {
  const data = await getJson('/api/sessions');
  const sessions = data.sessions || [];
  subtitle.textContent = sessions.length + (sessions.length === 1 ? ' session' : ' sessions');

  if (sessions.length === 0) {
    app.innerHTML = '<div class="empty"><strong>No sessions captured yet</strong>' +
      'Run <code>kodus trace enable</code>, then start an agent session in this repository.</div>';
    return;
  }

  const rows = sessions.map((s) => \`
    <tr data-id="\${esc(s.sessionId)}">
      <td>\${fmtDate(s.startedAt || s.updatedAt)}</td>
      <td>\${esc(s.branch || '—')}</td>
      <td>\${esc(s.agentType || '—')}</td>
      <td>\${s.turnCount}</td>
      <td class="files">\${esc((s.filesTouched || []).slice(0, 6).join(', ')) || '—'}</td>
    </tr>\`).join('');

  app.innerHTML = \`<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Branch</th><th>Agent</th><th>Turns</th><th>Files touched</th></tr></thead>
    <tbody>\${rows}</tbody></table></div>\`;

  app.querySelectorAll('tbody tr').forEach((row) => {
    row.addEventListener('click', () => {
      location.hash = '#/session/' + encodeURIComponent(row.dataset.id);
    });
  });
}

async function renderDetail(sessionId) {
  const data = await getJson('/api/sessions/' + encodeURIComponent(sessionId));
  const session = data.session;
  subtitle.textContent = sessionId;

  if (!session) {
    app.innerHTML = '<a class="back" href="#/">← All sessions</a>' +
      '<div class="empty"><strong>Record not found</strong>This session is no longer in the local store.</div>';
    return;
  }

  const head = \`
    <a class="back" href="#/">← All sessions</a>
    <h2 style="font-size:16px;margin:14px 0 4px">\${esc(session.branch || 'unknown branch')}</h2>
    <p style="margin:0 0 16px;color:var(--muted);font-size:13px">
      <span class="badge">\${esc(session.agentType || 'unknown agent')}</span>
      <span class="badge">\${session.turns.length} turns</span>
      started \${fmtDate(session.startedAt)}\${session.endedAt ? ' · ended ' + fmtDate(session.endedAt) : ''}
    </p>\`;

  const warn = session.corruptLines > 0
    ? '<p class="warn">' + session.corruptLines + ' unreadable line(s) in this record were skipped.</p>'
    : '';

  const decisions = (data.decisions || []).map((d) => \`
    <div class="decision">
      <div><strong>\${esc(d.decision)}</strong></div>
      \${d.rationale ? '<div class="why">' + esc(d.rationale) + '</div>' : ''}
      <div class="why"><span class="badge">\${esc(d.type)}</span>\${esc((d.scope || []).join(', '))}</div>
    </div>\`).join('');

  const decisionsBlock = decisions
    ? '<h3 style="font-size:13px;color:var(--muted);margin:20px 0 10px">Decisions from this session</h3>' + decisions
    : '';

  const turns = session.turns.map((t, i) => \`
    <div class="turn">
      <h3>Turn \${i + 1} · \${fmtDate(t.startedAt || t.endedAt)}</h3>
      \${t.prompt ? '<div class="label">Prompt</div><pre>' + esc(t.prompt) + '</pre>' : ''}
      \${t.response ? '<div class="label">Response</div><pre>' + esc(t.response) + '</pre>' : ''}
      \${(t.toolCalls || []).length ? '<div class="label">Tool calls</div><ul class="compact">' +
        t.toolCalls.map((c) => '<li>' + esc(c.toolName) + (c.summary ? ' — ' + esc(c.summary) : '') + '</li>').join('') +
        '</ul>' : ''}
      \${(t.filesModified || []).length ? '<div class="label">Files modified</div><ul class="compact">' +
        t.filesModified.map((f) => '<li>' + esc(f.path) + ' (' + esc(f.action) + ')</li>').join('') +
        '</ul>' : ''}
    </div>\`).join('');

  app.innerHTML = head + warn + decisionsBlock +
    (turns || '<div class="empty"><strong>No turns recorded</strong>This session ended before any turn completed.</div>');
}

async function route() {
  const hash = location.hash || '#/';
  try {
    const match = hash.match(/^#\\/session\\/(.+)$/);
    if (match) {
      await renderDetail(decodeURIComponent(match[1]));
    } else {
      await renderList();
    }
  } catch (error) {
    app.innerHTML = '<div class="empty"><strong>Could not load the local store</strong>' + esc(error.message) + '</div>';
  }
}

window.addEventListener('hashchange', route);
route();
</script>
</body>
</html>
`;
}
