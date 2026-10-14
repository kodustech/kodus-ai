#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * H5 (#1821): passo 2 do verify C trocado. Em vez do c3 (o modelo julga se a
 * evidencia contradiz), o modelo lista as premissas necessarias do defeito e,
 * para cada uma, um check executavel com o resultado que teria se a premissa
 * fosse verdadeira. O codigo roda os checks (git grep / leitura no head ou na
 * base / trecho num sandbox E2B) e decide: cai o comentario cuja premissa
 * necessaria ao defeito falha num check. Check que nao roda (arquivo ou padrao
 * invalido, erro do sandbox) e inconclusivo e nao derruba. Roda em TODOS os
 * grupos do passo 1 (nao so nos refuted), com o claim e a evidencia dele.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/h5.js --model=<gold model> --sobre=<versao do passo 1> --versao=<rotulo> [--prefixo=09.10.26] [--par=3]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada } = require(path.join(INV, 'eval-structured'));
const { repoDirFor } = require(path.join(INV, 'prepare-repo'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), SOBRE = arg('sobre'), VERSAO = arg('versao'), PREFIXO = arg('prefixo', '09.10.26'), PAR = Number(arg('par', '3'));
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !SOBRE || !VERSAO || !MODELO) { console.error('RECALL_MODEL=<id> --model= --sobre= --versao='); process.exit(2); }
const OUT = path.join(__dirname, 'resultados', `aluc-${VERSAO}`, `${GOLD}.json`);

const CHECK = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'premiseTrueIf'],
    properties: {
        kind: { type: 'string', enum: ['search', 'file_contains', 'snippet'] },
        pattern: { type: 'string', description: 'search: extended regex for git grep' },
        pathGlob: { type: 'string', description: 'search: optional path or glob to limit the search' },
        path: { type: 'string', description: 'file_contains: repository path' },
        text: { type: 'string', description: 'file_contains: exact text, compared ignoring whitespace' },
        ref: { type: 'string', enum: ['head', 'base'], description: 'file_contains: the pull request head or the base before it' },
        language: { type: 'string', enum: ['python', 'node', 'bash'] },
        code: { type: 'string', description: 'snippet: self-contained code that prints its result' },
        premiseTrueIf: { type: 'string', description: 'search: "found" or "not_found"; file_contains: "contains" or "not_contains"; snippet: the text stdout contains when the premise is true' },
    },
};
const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['premises'],
    properties: {
        premises: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['premise', 'neededForDefect', 'check'],
                properties: { premise: { type: 'string' }, neededForDefect: { type: 'boolean' }, check: CHECK },
            },
        },
    },
};

const prompt = (s, g) => `An AI code reviewer wants to post the comment below on a pull request. Another checker already looked at the repository; its notes are below.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

<Checker notes>
Claim checked: ${g.claim || '-'}
Evidence: ${g.evidence || '-'}
Reason: ${g.reason || '-'}
</Checker notes>

List the premises that must be true for the reported defect to exist, at most 6, the most decisive first. Include the ones the comment takes for granted: that a caller, override, file or setting exists; that the code at the cited lines does what the comment says; that the pull request introduced or changed the behavior; how the language, a library or a tool behaves.

For each premise write ONE check that a program can run, and the result it gives when the premise is TRUE:
- "search": a git grep extended regex over the repository at the pull request head (optional pathGlob). premiseTrueIf "found" or "not_found".
- "file_contains": exact text in a file at the head or at the base commit (before the pull request); whitespace is ignored. premiseTrueIf "contains" or "not_contains".
- "snippet": a small self-contained python, node or bash program (no access to this repository) that prints a result. premiseTrueIf is the text stdout contains when the premise is true.

Mark neededForDefect false for premises that only support the claimed impact or severity. Write checks that are precise: a wrong pattern or path makes the check meaningless. Answer with submit.`;

const norm = (t) => String(t).replace(/\s+/g, '');

async function roda(chk, ctx) {
    try {
        if (chk.kind === 'search') {
            if (!chk.pattern) return { ok: null, saida: 'no pattern' };
            // -P: os modelos escrevem regex no estilo Perl (\\s, \\d, \\b), que o -E (POSIX) nao entende.
            const a = ['-C', ctx.repoDir, 'grep', '-n', '-P', '-I', '-e', chk.pattern, ctx.head];
            if (chk.pathGlob) a.push('--', chk.pathGlob);
            let out = '';
            try { out = execFileSync('git', a, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
            catch (e) { if (e.status === 1) out = ''; else return { ok: null, saida: `grep failed: ${String(e.stderr || e.message).slice(0, 150)}` }; }
            const achou = out.trim().length > 0;
            if (!['found', 'not_found'].includes(chk.premiseTrueIf)) return { ok: null, saida: 'bad premiseTrueIf' };
            return { ok: (chk.premiseTrueIf === 'found') === achou, saida: `${out.split('\n').filter(Boolean).length} matches` };
        }
        if (chk.kind === 'file_contains') {
            const ref = chk.ref === 'base' ? ctx.base : ctx.head;
            let txt;
            try { txt = execFileSync('git', ['-C', ctx.repoDir, 'show', `${ref}:${String(chk.path || '').replace(/^\/+/, '')}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
            catch { return { ok: null, saida: 'file not found' }; }
            if (!chk.text || !['contains', 'not_contains'].includes(chk.premiseTrueIf)) return { ok: null, saida: 'bad check' };
            const tem = norm(txt).includes(norm(chk.text));
            return { ok: (chk.premiseTrueIf === 'contains') === tem, saida: tem ? 'contains' : 'does not contain' };
        }
        if (chk.kind === 'snippet') {
            const bin = { python: 'python3', node: 'node', bash: 'bash' }[chk.language];
            if (!bin || !chk.code || !chk.premiseTrueIf) return { ok: null, saida: 'bad snippet' };
            if (!ctx.sandbox) { const { Sandbox } = require('e2b'); ctx.sandbox = await Sandbox.create({ apiKey: process.env.API_E2B_KEY, timeoutMs: 10 * 60 * 1000 }); }
            const arq = `/tmp/s.${{ python: 'py', node: 'js', bash: 'sh' }[chk.language]}`;
            await ctx.sandbox.files.write(arq, chk.code);
            let r;
            try { r = await ctx.sandbox.commands.run(`${bin} ${arq}`, { timeoutMs: 20000 }); }
            catch (e) { r = { exitCode: e?.exitCode, stdout: e?.stdout || '', stderr: e?.stderr || String(e?.message || e) }; }
            // Erro de execucao sem saida: o trecho nao rodou, nao prova nada.
            if (r.exitCode !== 0 && !String(r.stdout).trim()) return { ok: null, saida: `exit ${r.exitCode}: ${String(r.stderr).slice(0, 150)}` };
            return { ok: String(r.stdout).includes(chk.premiseTrueIf), saida: String(r.stdout).slice(0, 300) };
        }
        return { ok: null, saida: 'unknown kind' };
    } catch (e) {
        return { ok: null, saida: `error: ${String(e?.message || e).slice(0, 150)}` };
    }
}

async function recheck(origem) {
    const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', `aluc-${origem}`, `${GOLD}.json`), 'utf8'));
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    for (const [cid, p] of Object.entries(src.prs)) {
        if (p.erro) continue;
        const v = vars[cid]; const head = v.benchmarkHeadRef;
        const ctx = { repoDir: repoDirFor(v.repositoryFullName), head, base: v.benchmarkBaseRef || `${head}^` };
        for (const g of p.grupos) {
            for (const c of (g.checks || []).filter(Boolean)) if (c.check?.kind !== 'snippet') c.resultado = await roda(c.check || {}, ctx);
            g.nit = !!(g.checks || []).filter(Boolean).find((c) => c.neededForDefect && c.resultado.ok === false);
        }
    }
    src.versao = VERSAO; src.recheckDe = origem;
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(src, null, 1));
    const todos = Object.values(src.prs).filter((p) => !p.erro).flatMap((p) => p.grupos);
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, grupos: todos.length, caem: todos.filter((g) => g.nit).length }));
}

(async () => {
    if (arg('recheck')) { await recheck(arg('recheck')); process.exit(0); }
    const model = buildModel(MODELO);
    console.log(`[verify-h5] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD} · sobre ${SOBRE}`);
    const passo1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', `aluc-${SOBRE}`, `${GOLD}.json`), 'utf8')).prs;
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, sobre: SOBRE, prs: {} };
    // Pasta de outro experimento com o mesmo rotulo: retomar dela pularia todos os PRs.
    if (res.sobre !== SOBRE) { console.error(`${OUT} e de outro experimento; use outra --versao`); process.exit(2); }
    const SO = arg('prs') ? new Set(fs.readFileSync(arg('prs'), 'utf8').split(/\s+/).filter(Boolean)) : null;
    const fila = Object.keys(passo1).filter((c) => (!SO || SO.has(c)) && !passo1[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        const v = vars[cid];
        const repoDir = repoDirFor(v.repositoryFullName);
        const head = v.benchmarkHeadRef;
        const ctx = { repoDir, head, base: v.benchmarkBaseRef || `${head}^` };
        try {
            const S = Object.fromEntries(sug[cid].suggestions.map((x) => [x.id, x]));
            const out = [];
            for (const g of passo1[cid].grupos || []) {
                let dados = null;
                for (let t = 1; t <= 3 && !dados; t++) {
                    try {
                        const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema: SCHEMA, prompt: prompt(S[g.rep], g) });
                        if (Array.isArray(r.dados?.premises)) dados = r.dados;
                    } catch (e) { if (t === 3) console.error(cid, g.rep, String(e?.message || e).slice(0, 150)); }
                }
                const checks = [];
                for (const p of (dados?.premises || []).slice(0, 6)) checks.push({ ...p, resultado: await roda(p.check || {}, ctx) });
                const falha = checks.find((c) => c.neededForDefect && c.resultado.ok === false);
                out.push({ rep: g.rep, membros: g.membros, nit: !!falha, passo1: g.verdict, checks, ...(dados ? {} : { erro: 'sem premissas' }) });
            }
            res.prs[cid] = { grupos: out };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${out.length} comentarios, ${out.filter((x) => x.nit).length} caem`);
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${res.prs[cid].erro}`);
        } finally {
            if (ctx.sandbox) await ctx.sandbox.kill().catch(() => {});
            fs.mkdirSync(path.dirname(OUT), { recursive: true });
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const todos = Object.values(res.prs).filter((p) => !p.erro).flatMap((p) => p.grupos);
    const cks = todos.flatMap((g) => g.checks || []).filter(Boolean);
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, grupos: todos.length, caem: todos.filter((g) => g.nit).length, checks: cks.length, inconclusivos: cks.filter((c) => c.resultado.ok === null).length }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
