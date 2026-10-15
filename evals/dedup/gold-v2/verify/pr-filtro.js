#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Filtro por PR depois do dedup (#1821): um agente por PR recebe titulo, descricao,
 * diff e TODOS os comentarios que sairam do dedup, investiga no repositorio
 * (grep/readFile/listDir/prDiff/readBaseFile, teto alto) e classifica cada um.
 * Substitui verify C + nit protegido. Versoes:
 *   pf1 = o prompt do filtro cego (post sim/nao);
 *   pf2 = pf1 + trava de recall: o modelo da o tipo e o codigo decide o corte
 *         (cai: alucinacao, nao-achado, nit, defensivo, especulativo).
 *   pf3 = formato do pf1, mas nit vira tarefa de evidencia (montar o cenario de falha) e
 *         alucinacao so cai se o trecho citado existir mesmo no arquivo (conferido em codigo).
 *   pf3d = pf3 sem o diff no prompt: so a lista de arquivos alterados; o diff vem pela ferramenta prDiff.
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/pr-filtro.js --model=<gold model> --versao=pf1 [--teto=40] [--par=3] [--prefixo=09.10.26]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { extraiJson } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const PREFIXO = arg('prefixo', '09.10.26');
const GOLD = arg('model'), VERSAO = arg('versao', 'pf1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const TETO = Number(arg('teto', '40'));
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO || !['pf1', 'pf2', 'pf3', 'pf3d'].includes(VERSAO)) { console.error('RECALL_MODEL=<id> --model=<gold model> --versao=pf1|pf2|pf3|pf3d'); process.exit(2); }
const BASE = VERSAO === 'pf3d' ? 'pf3' : VERSAO;
const DIFF_INLINE = VERSAO !== 'pf3d';
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const SO_PRS = arg('prs') ? new Set(fs.readFileSync(arg('prs'), 'utf8').split(/\s+/).filter(Boolean)) : null;
const H3 = true, H2 = false, H4 = false;

function prDiff(cmd, p) {
    try {
        const a = ['-C', cmd.repoRoot, 'diff', `${cmd.baseRef}...${cmd.headRef}`];
        if (p) a.push('--', String(p).replace(/^\/+/, ''));
        else a.push('--stat');
        const out = require('child_process').execFileSync('git', a, { maxBuffer: 32 * 1024 * 1024 }).toString();
        return (out || 'no changes in this file').slice(0, 12000);
    } catch (e) { return `diff failed: ${String(e?.message || e).slice(0, 200)}`; }
}
function grupos(sugs, final, entrada) {
    const chegou = new Set(entrada);
    const porGrupo = {};
    const out = [];
    for (const s of sugs) {
        if (!chegou.has(s.id)) continue;
        const g = final[s.id]?.grupo;
        if (g) (porGrupo[g] = porGrupo[g] || []).push(s); else out.push([s]);
    }
    out.push(...Object.values(porGrupo));
    return out.map((m) => {
        const rep = m.reduce((a, b) => (String(b.suggestionContent).length > String(a.suggestionContent).length ? b : a));
        return { rep: rep.id, membros: m.map((x) => x.id), s: rep };
    });
}

function ferramentas(cmd) {
    return {
        ...(cmd.baseRef ? { readBaseFile: tool({
            description: 'Read a file as it was BEFORE the pull request (base commit), optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => {
                try {
                    const out = require('child_process').execFileSync('git', ['-C', cmd.repoRoot, 'show', `${cmd.baseRef}:${String(p).replace(/^\/+/, '')}`], { maxBuffer: 32 * 1024 * 1024 }).toString();
                    const ls = out.split('\n'); const a = Math.max(1, Number(startLine) || 1), b = Math.min(ls.length, Number(endLine) || ls.length);
                    return ls.slice(a - 1, b).map((l, k) => `${a + k}: ${l}`).join('\n').slice(0, 12000);
                } catch { return 'file not found at the base commit (new in this pull request, or wrong path)'; }
            },
        }) } : {}),
        ...(H3 ? { prDiff: tool({
            description: 'Show the pull request diff of one file (or, with no path, the list of changed files).',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }),
            execute: async ({ path: p }) => prDiff(cmd, p),
        }) } : {}),
        ...(H2 ? { getCallers: tool({
            description: 'List the call sites of a function or method in the repository call graph, marking callers that are tests.',
            inputSchema: jsonSchema({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }),
            execute: async ({ name }) => getCallers(cmd, name),
        }) } : {}),
        ...(H4 ? { runSnippet: tool({
            description: 'Run a small self-contained snippet in an isolated sandbox and return its exit code, stdout and stderr. No access to this repository.',
            inputSchema: jsonSchema({ type: 'object', properties: { language: { type: 'string', enum: ['python', 'node', 'bash'] }, code: { type: 'string' } }, required: ['language', 'code'], additionalProperties: false }),
            execute: async ({ language, code }) => rodaTrecho(cmd, language, code),
        }) } : {}),
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => String(await cmd.grep(pattern, p, glob)).slice(0, 6000),
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); },
        }),
        listDir: tool({
            description: 'List a directory of the repository.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, maxDepth: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, maxDepth }) => String(await cmd.listDir(p, maxDepth)).slice(0, 6000),
        }),
    };
}


const TIPOS1 = ['real_defect', 'hallucination', 'nitpick', 'defensive', 'speculative', 'preexisting', 'absurd'];
const TIPOS2 = ['real_defect', 'minor_real_defect', 'hallucination', 'non_finding', 'nitpick', 'defensive', 'speculative', 'preexisting'];
const CAI2 = new Set(['hallucination', 'non_finding', 'nitpick', 'defensive', 'speculative']);
const TIPOS3 = ['defect', 'hallucination', 'no_concrete_failure', 'non_finding'];
const SCHEMA3 = {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: { items: { type: 'array', items: {
        type: 'object', additionalProperties: false, required: ['id', 'kind', 'scenario', 'refutation', 'reason'],
        properties: {
            id: { type: 'string' },
            kind: { type: 'string', enum: TIPOS3 },
            scenario: { type: 'string', description: 'For defect: the concrete input or state, the path through the code (file:line), and what the user or caller observes that is wrong. Empty otherwise.' },
            refutation: { type: 'object', additionalProperties: false, required: ['file', 'line', 'quote'], description: 'For hallucination: the code that contradicts the comment. Empty strings and 0 otherwise.',
                properties: { file: { type: 'string' }, line: { type: 'number' }, quote: { type: 'string', description: 'One line of code copied exactly from the file at that line.' } } },
            reason: { type: 'string', description: 'One or two sentences.' },
        } } } },
};
const SCHEMA = BASE === 'pf3' ? SCHEMA3 : {
    type: 'object', additionalProperties: false, required: ['items'],
    properties: { items: { type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: BASE === 'pf1' ? ['id', 'post', 'kind', 'reason'] : ['id', 'kind', 'reason'],
        properties: {
            id: { type: 'string' },
            ...(BASE === 'pf1' ? { post: { type: 'boolean' } } : {}),
            kind: { type: 'string', enum: BASE === 'pf1' ? TIPOS1 : TIPOS2 },
            reason: { type: 'string', description: 'One or two sentences with the code evidence (file:line).' },
        } } } },
};

const coment = (g) => `<comment id="${g.rep}">
File: ${g.s.relevantFile}
Lines: ${g.s.relevantLinesStart ?? '?'}-${g.s.relevantLinesEnd ?? '?'}
${String(g.s.suggestionContent || '').trim()}
</comment>`;

const CABECA = (v, diff) => `You are the final filter of an automated code reviewer. Below are a pull request (title, description, diff) and the comments the reviewer wants to post on it, already deduplicated. Decide, for every comment, what it is.

<PullRequest>
Title: ${v.prTitle || ''}
Description:
${String(v.prBody || '').slice(0, 4000)}
</PullRequest>

${DIFF_INLINE ? `<Diff>\n${diff}\n</Diff>` : `<ChangedFiles>\n${diff}\n</ChangedFiles>\nThe diff is not shown here: read the diff of any file with prDiff.`}`;

const COMO = `How to work:
- Verify the facts each comment relies on in the repository at the pull request head: read the cited code, the code it names, its callers, the types and the config. Do not trust the comment's own description of the code. Tools: grep, readFile, listDir, prDiff (diff of one file, or the list of changed files), readBaseFile (a file before the pull request).
- Judge the comments of this pull request together, against its purpose: a comment much less important than the rest is more likely to be noise.
- When you have judged every comment, call submit once with one item per comment id.`;

const P1 = `Post a comment only if BOTH hold:
1. It is correct: the defect it describes really exists in the code at the pull request head.
2. It is worth the author's time: it points out a real defect in behaviour that the change introduces or touches — a bug, a security problem, data loss, a broken contract, a meaningful test gap for the change. Drop nitpicks (style, naming, wording, comments/docs, micro-performance, theoretical edge cases nobody hits), defensive programming for states the code cannot reach, speculative "verify that..." requests, and problems that existed before the pull request and are unrelated to it.

For each comment give post (true/false), kind and a short reason with the code evidence. kind: real_defect, hallucination (a fact it relies on is false in the code), nitpick, defensive, speculative, preexisting, absurd (not a finding at all).`;

const P2 = `Give each comment exactly one kind:
- real_defect: the defect exists in the code at the pull request head and changes what the program does — a bug, a crash, a wrong result, a security problem, data loss, a broken caller or contract — introduced or touched by this change.
- minor_real_defect: the defect exists and the change introduces it, but its effect is small: a narrow edge case, dead or no-op code the change adds, code that contradicts its own documented contract, type or the convention its sibling functions follow, a test that does not verify what it claims, a resource or cleanup problem.
- hallucination: a fact the comment relies on is false in the code (a call, caller, value, check, type or behaviour that is not what the comment says), so the problem does not exist.
- non_finding: the comment reports no problem (says the code is fine, or is empty or unreadable).
- nitpick: true but only about style, naming, wording, comments or docs, formatting, or a micro-optimisation, with no change in behaviour.
- defensive: asks to guard against a state that no current code path can produce.
- speculative: asks to verify or consider something without stating a defect that the code shows ("make sure that...", "if a caller ever...").
- preexisting: a real defect that existed before this pull request and that the change does not touch.

Prefer real_defect or minor_real_defect whenever you confirmed the defect in the code and it changes behaviour, even slightly. Use hallucination only when you found the code that contradicts the comment, and cite it.`;

const P3 = `For every comment, try to build the failure it describes, from the code at the pull request head:
- defect: you can name a concrete input or state that current code can produce, follow it through the code (cite file:line), and say what the user or a caller observes that is wrong — a crash, an error, a wrong result or value, wrong data stored, a security hole, a caller that breaks, a test that would let the changed behaviour ship broken, or documentation of a contract that now misstates what the code does. Small effects count: if the failure is concrete, it is a defect. Write it in scenario.
- hallucination: a fact the comment relies on is false — the code does not call, contain, pass or return what the comment says. Put the contradicting line in refutation: the file, the line number and that line of code copied exactly. Only use this when you read that line yourself.
- no_concrete_failure: what the comment points at is real, but you cannot build any input or state that current code produces after which something observable goes wrong: style, naming, wording, comments, dead-but-harmless code, a micro-optimisation, a guard against a state no current code path reaches, or a request to "verify" or "consider" something.
- non_finding: the comment reports no problem, or is empty or unreadable.
If you cannot decide between defect and no_concrete_failure, choose defect.`;

const prompt = (v, diff, gs) => `${CABECA(v, diff)}

${COMO}

${BASE === 'pf1' ? P1 : BASE === 'pf2' ? P2 : P3}

<Comments>
${gs.map(coment).join('\n\n')}
</Comments>`;

const normLinha = (t) => String(t || '').replace(/\s+/g, ' ').trim();
/** A refutacao vale se a linha citada existe no arquivo, a ate 3 linhas do numero informado. */
async function confereRefutacao(cmd, r) {
    if (!r || !r.file || !normLinha(r.quote)) return false;
    try {
        const n = Number(r.line) || 1;
        const t = String(await cmd.read(String(r.file).replace(/^\/+/, ''), Math.max(1, n - 3), n + 3));
        const q = normLinha(r.quote);
        return t.split('\n').some((l) => { const x = normLinha(l); return x.length > 0 && (x.includes(q) || (q.includes(x) && x.length >= 12)); });
    } catch { return false; }
}

async function julgaPr(model, cmd, v, diff, gs) {
    let resp = null;
    const tools = { ...ferramentas(cmd),
        submit: tool({ description: 'Submit the judgement of every comment. Call exactly once.', inputSchema: jsonSchema(SCHEMA), execute: async (x) => { resp = x; return 'recorded'; } }) };
    const r = await generateText({
        model, prompt: prompt(v, diff, gs), tools,
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now with every comment id, from what you already know.' }] }
            : undefined,
    });
    const d = resp || extraiJson(r.text || '');
    const by = Object.fromEntries((d?.items || []).map((x) => [x.id, x]));
    if (gs.some((g) => !by[g.rep])) throw new Error(`faltaram ids: ${gs.filter((g) => !by[g.rep]).map((g) => g.rep).join(',')}`);
    const usage = r.totalUsage || r.usage || {};
    return { by, passos: r.steps?.length ?? 0, tin: usage.inputTokens || 0, tout: usage.outputTokens || 0 };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[pr-filtro] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD} · teto ${TETO}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.json`), 'utf8')).prs;
    const fin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.final.json`), 'utf8')).prs;
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); };
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, versaoDedup: DEDUP, teto: TETO, prs: {} };
    if (res.versao !== VERSAO) { console.error(`${OUT} e de outra versao (${res.versao})`); process.exit(2); }
    const fila = Object.keys(sug).filter((c) => (!SO_PRS || SO_PRS.has(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h; const t0 = Date.now();
        try {
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []);
            let out = [], meta = {};
            if (gs.length) {
                h = await prepareRepo(vars[cid], `${cid}-pf-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                cmd.headRef = vars[cid].benchmarkHeadRef; cmd.baseRef = vars[cid].benchmarkBaseRef || `${cmd.headRef}^`;
                const r = await retry(() => julgaPr(model, cmd, vars[cid], DIFF_INLINE ? diffDe(vars[cid]) : prDiff(cmd), gs));
                out = [];
                for (const g of gs) {
                    const x = r.by[g.rep];
                    let cai, conferida;
                    if (BASE === 'pf1') cai = x.post === false;
                    else if (BASE === 'pf2') cai = CAI2.has(x.kind);
                    else if (x.kind === 'hallucination') { conferida = await confereRefutacao(cmd, x.refutation); cai = conferida; }
                    else cai = x.kind === 'no_concrete_failure' || x.kind === 'non_finding';
                    out.push({ rep: g.rep, membros: g.membros, nit: cai, kind: x.kind, reason: x.reason,
                        ...(BASE === 'pf3' ? { scenario: x.scenario, refutation: x.refutation, refutacaoConferida: conferida } : {}) });
                }
                meta = { passos: r.passos, tokensEntrada: r.tin, tokensSaida: r.tout, segundos: Math.round((Date.now() - t0) / 1000) };
            }
            res.prs[cid] = { grupos: out, ...meta };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} comentarios, ${out.filter((x) => x.nit).length} caem, ${meta.passos ?? 0} passos`);
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${res.prs[cid].erro}`);
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const todos = ok.flatMap((p) => p.grupos);
    const soma = (k) => ok.reduce((a, p) => a + (p[k] || 0), 0);
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: todos.length, caem: todos.filter((x) => x.nit).length,
        passosMedio: +(soma('passos') / Math.max(1, ok.length)).toFixed(1), tokensEntrada: soma('tokensEntrada'), tokensSaida: soma('tokensSaida'), segundosMedio: Math.round(soma('segundos') / Math.max(1, ok.length)) }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
