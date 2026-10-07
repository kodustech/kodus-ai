#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: verify em painel, cada pergunta separada e regra fixa no fim (sem debate).
 * Sobre a fila do corte de 65%; as 3 primeiras de cada PR passam direto.
 *
 *   P1 verdade local  (uma chamada por PR, one-shot): diff + o codigo das linhas
 *                     citadas, lido do repositorio; o trecho faz o que o comentario diz?
 *   P2 mitigacao      (uma sessao por sugestao, ferramentas, teto 5): existe algo no
 *                     repositorio que impede a falha? "sim" so vale com o codigo citado
 *                     conferido no arquivo.
 *   P3 relevancia     (uma chamada por PR, one-shot): titulo e descricao do PR + diff;
 *                     ORDENA os comentarios fora do topo pelo quanto o autor precisa
 *                     corrigi-los antes do merge. Comparativa, nunca nota absoluta.
 * Grava os tres sinais de cada sugestao; as regras sao combinadas offline.
 *
 *   RECALL_MODEL=<id> node verify-painel.js --fila=<arq> --fusao=<arq> --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada, extraiJson } = require('./eval-structured');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { TIER0 } = require('../shared/tier0-models');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const Q = JSON.parse(fs.readFileSync(arg('fila'), 'utf8'));
const F = JSON.parse(fs.readFileSync(arg('fusao'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const PELO_SDK = TIER0[MODELO]?.provider === 'claude_agent_sdk';
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const TOPO = 3, TETO = 5;

// ---------- P1 ----------
const SCHEMA_P1 = { type: 'object', properties: { itens: { type: 'array', items: { type: 'object', properties: { indice: { type: 'number' }, matches: { type: 'boolean' }, reason: { type: 'string' } }, required: ['indice', 'matches', 'reason'], additionalProperties: false } } }, required: ['itens'], additionalProperties: false };
const p1Tool = tool({ description: 'Record the answer for every comment. Call exactly once.', inputSchema: jsonSchema(SCHEMA_P1), execute: async () => ({ output: 'ok' }) });
const promptP1 = (itens, diff) => `<Diff>
${diff}
</Diff>

Below are code review comments, each with the code at the lines it cites, read from the repository at the pull request head.

${itens.map((x, i) => `[${i}] ${x.file}:${x.ini ?? '?'}-${x.fim ?? '?'}\nComment: ${String(x.texto).slice(0, 1200)}\nCode:\n${x.codigo || '(not available)'}`).join('\n\n')}

For each comment answer ONE question: does the cited code (with the diff) actually do what the comment says it does — the condition, the call, the value, the missing check it describes? Answer only about what the code does, not about whether it matters. matches = false only when the code clearly does not do what the comment claims.

Call the tool once with an entry for every index.`;

// ---------- P3 ----------
const SCHEMA_P3 = { type: 'object', properties: { ordem: { type: 'array', items: { type: 'number' }, description: 'Every index, from the one the author most needs to fix to the least.' } }, required: ['ordem'], additionalProperties: false };
const p3Tool = tool({ description: 'Record the ranking. Call exactly once.', inputSchema: jsonSchema(SCHEMA_P3), execute: async () => ({ output: 'ok' }) });
const promptP3 = (v, itens, diff) => `<PullRequest>
Title: ${v.prTitle || ''}
Description:
${String(v.prBody || '').slice(0, 4000)}
</PullRequest>

<Diff>
${diff}
</Diff>

Below are review comments on this pull request.

${itens.map((x, i) => `[${i}] ${x.file}:${x.ini ?? '?'}-${x.fim ?? '?'}\n${String(x.texto).slice(0, 1200)}`).join('\n\n')}

Rank ALL of them by how much the author of THIS pull request needs to fix each one before merging, given what the pull request is trying to do. First: defects that break what the pull request changes or intends, or that users will hit in normal use. Last: remarks that are speculative, defensive, cosmetic, or unrelated to the purpose of the change.

Call the tool once with every index exactly once, most important first.`;

// ---------- P2 ----------
const SUBMIT_P2 = {
    type: 'object',
    properties: {
        prevented: { type: 'boolean' },
        evidence: { type: 'object', properties: { file: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, code: { type: 'string' } }, required: ['file', 'startLine', 'endLine', 'code'] },
        reason: { type: 'string' },
    },
    required: ['prevented', 'reason'],
};
const SYSTEM_P2 = `You check ONE thing about a reported code defect: is there anything ELSEWHERE in the repository that prevents it from happening — a caller that validates the input first, a guard or early return upstream, a type or schema that rules the value out, a default, a lock, a framework guarantee?

Use the tools: find the callers and the code paths that reach the cited code and read them. prevented = true only if you found the code that prevents it; then give that code as evidence (file, lines, exact code). Otherwise prevented = false. Do not judge whether the defect matters.`;
const promptP2 = (x, diff) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

Reported defect at ${x.file}:${x.ini ?? '?'}-${x.fim ?? '?'}:
${String(x.texto).slice(0, 1500)}

You have up to ${TETO} steps; the last one is your answer.`;

function ferramentas(cmd) {
    return {
        grep: tool({ description: 'Search the repository for a regex pattern (use it to find callers).', inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }), execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } } }),
        readFile: tool({ description: 'Read a file, optionally a line range.', inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }), execute: async ({ path: p, startLine, endLine }) => { try { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } } }),
    };
}
async function p2AiSdk(model, cmd, x, diff) {
    let enviado = null;
    const tools = { ...ferramentas(cmd), submitAnswer: tool({ description: 'Submit your answer. The only way to answer.', inputSchema: jsonSchema(SUBMIT_P2), execute: async (y) => { enviado = y; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM_P2, prompt: promptP2(x, diff) + '\nSubmit with submitAnswer.', tools,
        stopWhen: (s) => !!enviado || (s.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitAnswer'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitAnswer' } }), messages: [...messages, { role: 'user', content: 'Final step: submit now. If you did not find preventing code, prevented = false.' }] }
            : undefined,
    });
    return enviado || extraiJson(r.text || '');
}
async function p2Sdk(dir, x, diff) {
    const { carregaSdk, envDoProcesso } = require('./claude-sdk-runner');
    const sdk = await carregaSdk();
    let saida = '';
    try {
        for await (const msg of sdk.query({
            prompt: promptP2(x, diff) + '\nEnd your answer with ONLY a JSON object, no code fence: {"prevented":true|false,"evidence":{"file":"...","startLine":0,"endLine":0,"code":"..."},"reason":"..."}',
            options: { model: TIER0[MODELO].sdkModel, systemPrompt: SYSTEM_P2 + '\n\nRead the repository with the Read, Grep and Glob tools; your working directory is the repository at the pull request head.', tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'], settingSources: [], cwd: dir, maxTurns: TETO, env: envDoProcesso() },
        })) {
            if (msg.type === 'assistant') for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n';
            if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
        }
    } catch (e) { if (!saida) throw e; }
    return extraiJson(saida);
}

const limpa = (t) => String(t || '').replace(/^\s*\d+\s*[:|]\s?/, '').replace(/^[+-](?![+-])/, '').replace(/\s+/g, '');
function confere(dir, todos, ev) {
    if (!ev || !ev.file || !ev.code) return false;
    let rel = String(ev.file).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (path.isAbsolute(ev.file) && ev.file.startsWith(dir)) rel = path.relative(dir, ev.file);
    let abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { const a = todos.filter((f) => f === rel || f.endsWith('/' + rel)); if (a.length !== 1) return false; abs = path.join(dir, a[0]); }
    const linhas = fs.readFileSync(abs, 'utf8').split('\n');
    const ini = Math.max(0, (Number(ev.startLine) || 1) - 11), fim = Math.min(linhas.length, (Number(ev.endLine) || Number(ev.startLine) || linhas.length) + 10);
    const janela = linhas.slice(ini, fim).map(limpa).join('');
    const ped = String(ev.code).split(/\n|\.\.\.|…/).map(limpa).filter(Boolean);
    if (ped.join('').length < 10) return false;
    let pos = 0; for (const p of ped) { const k = janela.indexOf(p, pos); if (k < 0) return false; pos = k + p.length; }
    return true;
}
function codigoDe(dir, todos, x) {
    let rel = String(x.file || '').replace(/^\.?\/+/, ''); let abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { const a = todos.filter((f) => f === rel || f.endsWith('/' + rel)); if (a.length !== 1) return ''; abs = path.join(dir, a[0]); }
    const a = Number(x.ini), b = Number(x.fim) || a; if (!Number.isFinite(a) || a < 1) return '';
    const L = fs.readFileSync(abs, 'utf8').split('\n'); const from = Math.max(1, a - 3), to = Math.min(L.length, Math.min(b, a + 40) + 3);
    return L.slice(from - 1, to).map((l, k) => `${from + k}: ${l}`).join('\n');
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-painel] ${descreveModelo(MODELO)} · topo ${TOPO}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: 'painel', prs: {} };
    const fila = Object.keys(Q).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const reps = Q[cid] || [];
            const alvos = reps.slice(TOPO);
            const sinais = {};
            if (alvos.length) {
                const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                const textoDe = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto || cs[it.rep].suggestionContent]));
                h = await prepareRepo(vars[cid], `${cid}-pn-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                let todos = []; try { todos = execFileSync('git', ['-C', h.dir, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n'); } catch {}
                const itens = alvos.map((r) => ({ r, file: cs[r].relevantFile, ini: cs[r].relevantLinesStart, fim: cs[r].relevantLinesEnd, texto: textoDe[r] }));
                for (const x of itens) x.codigo = codigoDe(h.dir, todos, x);
                const [r1, r3] = await Promise.all([
                    retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'p1', schema: SCHEMA_P1, toolDef: p1Tool, prompt: promptP1(itens, diffs[cid]) })),
                    retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'p3', schema: SCHEMA_P3, toolDef: p3Tool, prompt: promptP3(vars[cid], itens, diffs[cid]) })),
                ]);
                const p1 = Object.fromEntries((r1.dados?.itens || []).map((x) => [Number(x.indice), x]));
                const ordem = (r3.dados?.ordem || []).map(Number).filter((k, j, a) => Number.isInteger(k) && k >= 0 && k < itens.length && a.indexOf(k) === j);
                for (let k = 0; k < itens.length; k++) if (!ordem.includes(k)) ordem.push(k);
                let t = 0;
                const p2 = {};
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (t < itens.length) {
                        const k = t++;
                        const d = await retry(async () => (PELO_SDK ? p2Sdk(h.dir, itens[k], diffs[cid]) : p2AiSdk(model, cmd, itens[k], diffs[cid])));
                        p2[k] = { prevented: d?.prevented === true, provaConfere: d?.prevented === true ? confere(h.dir, todos, d.evidence) : null, reason: String(d?.reason || '').slice(0, 300) };
                    }
                }));
                itens.forEach((x, k) => {
                    sinais[x.r] = { p1Matches: p1[k] ? p1[k].matches !== false : true, p1Reason: String(p1[k]?.reason || '').slice(0, 200), p2Prevented: p2[k].prevented && p2[k].provaConfere, p2Reason: p2[k].reason, p3Posicao: ordem.indexOf(k), p3Total: itens.length };
                });
            }
            res.prs[cid] = { topo: reps.slice(0, TOPO), sinais };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ss = ok.flatMap((p) => Object.values(p.sinais));
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, verificadas: ss.length, p1Nao: ss.filter((s) => !s.p1Matches).length, p2Impedido: ss.filter((s) => s.p2Prevented).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
