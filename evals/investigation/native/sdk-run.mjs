// N2 pelo Claude Agent SDK pela ASSINATURA: preset claude_code + nosso system prompt acrescentado, pedido simples,
// ferramentas de leitura, Sonnet 5.5, os 30 PRs. Uso: node sdk-run.mjs [--limit N] [--conc 3] [--proxy]
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const H = process.env.HOME, B = `${H}/kodus-ai-bench-1821/evals/investigation`, OUT = `${H}/native`;
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const LIMIT = Number(arg('limit', '0')), CONC = Number(arg('conc', '3')), PROXY = process.argv.includes('--proxy');
const RES = `${OUT}/res-sdk`; fs.mkdirSync(RES, { recursive: true });
// Autenticacao pela ASSINATURA (mesmo token dos testes no Claude Code), para isolar SDK x CLI.
const TOKEN = fs.readFileSync(`${H}/.claude-oauth`, 'utf8').trim();
const PP = JSON.parse(fs.readFileSync(`${OUT}/prompts-prod.json`, 'utf8'));
const ds = {}; for (const f of fs.readdirSync(`${B}/datasets`)) { if (!f.endsWith('.json')) continue; const v = JSON.parse(fs.readFileSync(`${B}/datasets/${f}`, 'utf8'))[0].vars; ds[v.caseId] = v; }
let L = JSON.parse(fs.readFileSync(`${B}/light-30.json`, 'utf8')); if (LIMIT) L = L.slice(0, LIMIT);
const repoDir = (full) => { for (const k of ['keycloak', 'grafana', 'cal.com', 'sentry', 'discourse']) if (full.toLowerCase().includes(k)) return `${H}/projects/benchmark/${k}`; };
const PROMPT = (t, b, d) => `You are reviewing a pull request in this repository. The working directory is checked out at the PR's head commit.

Title: ${t}

Description:
${b}

The complete diff of the pull request (base...head) is in ${d}.

Review this pull request. Report the real bugs, security problems and performance problems that this change introduces or makes worse. Read the code you need with your tools.

When you are done, answer with only a JSON array inside a \`\`\`json fence, one object per issue:
[{"file": "path/in/repo", "line": 123, "issue": "what is wrong and why it matters"}]
If you find no issue, answer with an empty array.`;
async function um(c) {
  const rf = `${RES}/${c}.json`; if (fs.existsSync(rf)) return;
  const v = ds[c]; const wt = `${OUT}/wt/ver-${c}`;
  if (!fs.existsSync(wt)) execFileSync('git', ['-C', repoDir(v.repositoryFullName), 'worktree', 'add', '--detach', wt, v.benchmarkHeadRef]);
  const dfile = `${OUT}/diffs/${c}.diff`;
  const t0 = Date.now(); let fim = null; let erro = null;
  try {
    for await (const m of query({ prompt: PROMPT(v.prTitle, (v.prBody || '').slice(0, 4000), dfile), options: {
      model: 'claude-sonnet-5-5', cwd: wt, additionalDirectories: [`${OUT}/diffs`],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PP[c].system },
      allowedTools: ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY')), CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ...(PROXY ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8765' } : {}) },
    } })) { if (m.type === 'result') fim = m; }
  } catch (e) { erro = String(e).slice(0, 500); }
  const res = fim?.result || ''; let achados = null;
  const mm = res.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  try { achados = JSON.parse(mm ? mm[1] : res); } catch {}
  fs.writeFileSync(rf, JSON.stringify({ caseId: c, segundos: Math.round((Date.now() - t0) / 1000), erro, is_error: fim?.is_error, subtype: fim?.subtype, num_turns: fim?.num_turns, custo_usd: fim?.total_cost_usd, usage: fim?.usage, modelos: Object.keys(fim?.modelUsage || {}), result: res, achados }));
}
fs.writeFileSync(`${OUT}/status-sdk`, `inicio ${new Date().toTimeString().slice(0, 5)} casos=${L.length}\n`);
let i = 0; await Promise.all(Array.from({ length: CONC }, async () => { while (i < L.length) { const c = L[i++]; await um(c); } }));
fs.appendFileSync(`${OUT}/status-sdk`, `END ${new Date().toTimeString().slice(0, 5)}\n`);
