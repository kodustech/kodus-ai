import http from 'node:http';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import { listSessionRecords } from '../../services/local-session-store.service.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

const DEFAULT_PORT = 7432;

function spaHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kodus Trace</title>
  <style>
    :root { color-scheme: light dark; --bg: #0f1115; --fg: #e8eaed; --muted: #9aa0a6; --card: #1a1d24; --accent: #7c9cff; --border: #2a2f3a; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; background: var(--bg); color: var(--fg); }
    header { padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); display: flex; gap: 1rem; align-items: center; }
    header h1 { font-size: 1.1rem; margin: 0; font-weight: 600; }
    header a { color: var(--accent); text-decoration: none; font-size: 0.9rem; }
    main { max-width: 960px; margin: 0 auto; padding: 1.5rem; }
    .empty { color: var(--muted); padding: 3rem 1rem; text-align: center; border: 1px dashed var(--border); border-radius: 12px; }
    .row { display: grid; grid-template-columns: 1fr auto auto auto; gap: 0.75rem; padding: 0.85rem 1rem; background: var(--card); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 0.5rem; cursor: pointer; }
    .row:hover { border-color: var(--accent); }
    .muted { color: var(--muted); font-size: 0.85rem; }
    .turn { border-left: 3px solid var(--accent); padding: 0.75rem 1rem; margin: 0.75rem 0; background: var(--card); border-radius: 0 8px 8px 0; }
    pre { white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; margin: 0.4rem 0 0; color: var(--muted); }
    h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; }
    .badge { font-size: 0.75rem; padding: 0.15rem 0.45rem; border-radius: 999px; background: #243049; color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <h1>Kodus Trace</h1>
    <a href="#/" id="home-link">Sessions</a>
    <span class="muted" id="meta"></span>
  </header>
  <main id="app"><div class="empty">Loading…</div></main>
  <script>
    async function api(path) {
      const res = await fetch(path);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    function el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') node.className = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v);
      }
      for (const c of [].concat(children)) {
        if (c == null) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
      return node;
    }
    function renderEmpty(msg) {
      const app = document.getElementById('app');
      app.innerHTML = '';
      app.appendChild(el('div', { className: 'empty' }, msg));
    }
    async function renderList() {
      const app = document.getElementById('app');
      app.innerHTML = '';
      let data;
      try { data = await api('/api/sessions'); }
      catch (e) { renderEmpty('Could not read local store.'); return; }
      document.getElementById('meta').textContent = data.repoRoot || '';
      if (!data.sessions || data.sessions.length === 0) {
        renderEmpty('No sessions yet. Run an agent with kodus trace enable, then refresh.');
        return;
      }
      for (const s of data.sessions) {
        const row = el('div', {
          className: 'row',
          onclick: () => { location.hash = '#/session/' + encodeURIComponent(s.sessionId); }
        }, [
          el('div', {}, [
            el('div', {}, s.sessionId),
            el('div', { className: 'muted' }, (s.startedAt || '') + (s.branch ? ' · ' + s.branch : '') + (s.agentType ? ' · ' + s.agentType : ''))
          ]),
          el('span', { className: 'badge' }, (s.turnCount || 0) + ' turns'),
          el('span', { className: 'muted' }, (s.fileCount || 0) + ' files'),
          el('span', { className: 'muted' }, s.decisionCount ? s.decisionCount + ' decisions' : '')
        ]);
        app.appendChild(row);
      }
    }
    async function renderDetail(id) {
      const app = document.getElementById('app');
      app.innerHTML = '';
      let s;
      try { s = await api('/api/sessions/' + encodeURIComponent(id)); }
      catch (e) { renderEmpty('Session not found or record is unreadable.'); return; }
      if (!s) { renderEmpty('Session not found or record is unreadable.'); return; }
      app.appendChild(el('h2', {}, 'Session ' + s.sessionId));
      app.appendChild(el('div', { className: 'muted' }, [
        (s.startedAt || ''), s.branch ? ' · ' + s.branch : '', s.agentType ? ' · ' + s.agentType : '',
        s.endedAt ? ' · ended ' + s.endedAt : ' · in progress'
      ].join('')));

      app.appendChild(el('h2', {}, 'Turns'));
      const turns = Array.isArray(s.turns) ? s.turns : [];
      if (turns.length === 0) {
        app.appendChild(el('div', { className: 'muted' }, 'No turns recorded (partial record).'));
      }
      for (const t of turns) {
        app.appendChild(el('div', { className: 'turn' }, [
          el('div', {}, 'Turn ' + (t.turnId || '')),
          t.prompt ? el('pre', {}, 'prompt: ' + t.prompt) : null,
          t.response ? el('pre', {}, 'response: ' + t.response) : null,
          (t.filesModified && t.filesModified.length) ? el('pre', {}, 'files: ' + t.filesModified.join(', ')) : null,
          (t.toolCalls && t.toolCalls.length) ? el('pre', {}, 'tools: ' + JSON.stringify(t.toolCalls)) : null
        ]));
      }

      app.appendChild(el('h2', {}, 'Decisions'));
      const decisions = Array.isArray(s.decisions) ? s.decisions : [];
      if (decisions.length === 0) {
        app.appendChild(el('div', { className: 'muted' }, 'No decisions extracted for this session.'));
      } else {
        for (const d of decisions) {
          app.appendChild(el('div', { className: 'turn' }, [
            el('div', {}, '[' + (d.id || '') + '] ' + (d.type || '') + (d.pinned ? ' (pinned)' : '')),
            el('pre', {}, d.decision || ''),
            d.rationale ? el('pre', {}, 'why: ' + d.rationale) : null
          ]));
        }
      }
    }
    function route() {
      const hash = location.hash || '#/';
      const m = hash.match(/^#\\/session\\/(.+)$/);
      if (m) renderDetail(decodeURIComponent(m[1]));
      else renderList();
    }
    window.addEventListener('hashchange', route);
    route();
  </script>
</body>
</html>`;
}

export async function uiAction(options: { port?: string } = {}): Promise<void> {
    const port = Number(
        options.port || process.env.KODUS_TRACE_UI_PORT || DEFAULT_PORT,
    );

    let repoRoot = process.cwd();
    try {
        if (await gitService.isGitRepository()) {
            repoRoot = (await gitService.getGitRoot()).trim();
        }
    } catch {
        // use cwd
    }

    const server = http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

            if (url.pathname === '/api/sessions') {
                const sessions = await listSessionRecords(repoRoot);
                const summary = sessions.map((s) => ({
                    sessionId: s.sessionId,
                    startedAt: s.startedAt,
                    endedAt: s.endedAt,
                    branch: s.branch,
                    agentType: s.agentType,
                    turnCount: s.turns?.length ?? 0,
                    fileCount: s.filesTouched?.length ?? 0,
                    decisionCount: s.decisions?.length ?? 0,
                }));
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                res.end(JSON.stringify({ repoRoot, sessions: summary }));
                return;
            }

            const detailMatch = url.pathname.match(/^\/api\/sessions\/(.+)$/);
            if (detailMatch) {
                const id = decodeURIComponent(detailMatch[1]);
                const sessions = await listSessionRecords(repoRoot);
                const session =
                    sessions.find((s) => s.sessionId === id) ?? null;
                res.writeHead(session ? 200 : 404, {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-store',
                });
                res.end(JSON.stringify(session));
                return;
            }

            // SPA shell — no external network assets
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(spaHtml());
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(error instanceof Error ? error.message : 'Internal error');
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });

    cliInfo(chalk.green(`Kodus Trace UI on http://127.0.0.1:${port}`));
    cliInfo(chalk.dim(`Reading local store for ${repoRoot}`));
    cliInfo(chalk.dim('No auth. No network calls. Ctrl+C to stop.'));

    // Keep process alive
    await new Promise<void>((resolve) => {
        const shutdown = () => {
            server.close(() => resolve());
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    });
}

/** Pure HTML builder exported for structural tests. */
export function buildUiHtml(): string {
    return spaHtml();
}

void fileURLToPath;
void path;
void fs;
void cliError;
void exitWithCode;
