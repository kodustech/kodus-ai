#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Defesa do verify de alucinacao (#1821): so os comentarios que as rodadas de
 * --sobre (alucinacao.js) refutaram; um agente com grep/readFile/listDir tenta
 * mostrar que o comentario esta certo. Remove so "refutation_holds".
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/alucinacao-defesa.js --model=<gold model> --sobre=h1,h3 --versao=h4 [--teto=8]
 */
const fs = require('fs');
const path = require('path');
const { grupos, carregaFinal } = require('../grupos-producao');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { extraiJson, chamadaEstruturada } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), VERSAO = arg('versao', 'h1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `aluc-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const TETO = Number(arg('teto', '6'));
const SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['refuted', 'confirmed', 'unverified'] },
        claim: { type: 'string', description: 'For refuted: the false sentence, copied word for word from the comment.' },
        evidence: { type: 'string', description: 'For refuted: file:line and the quoted code that contradicts the comment.' },
        reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['verdict', 'claim', 'evidence', 'reason'],
    additionalProperties: false,
};

const comentario = (s) => `<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>`;

const SCHEMA_D = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: ['refutation_holds', 'comment_holds', 'unsure'] },
        evidence: { type: 'string', description: 'file:line and quoted code behind your verdict.' },
        reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['verdict', 'evidence', 'reason'],
    additionalProperties: false,
};
SCHEMA.properties = SCHEMA_D.properties; SCHEMA.required = SCHEMA_D.required;

const PROMPTS = {
    d1: (s, refs) => `A code review comment was checked against the repository, and a checker says it rests on a false statement about the code. You are the comment's defender: before it is thrown away, look for code in this repository that shows the comment is right after all.

${comentario(s)}

<Refutation>
${refs.map((r) => `Claim attacked: ${r.claim || '(not given)'}\nEvidence: ${r.evidence}\nReason: ${r.reason}`).join('\n---\n')}
</Refutation>

Check the refutation with grep, readFile and listDir at this pull request's commit. Checkers often go wrong in these ways:
- the quoted code is not the code the comment talks about (another file, another function, an unrelated part of the repo);
- the quoted code is real, but other code on the path overrides it (a per-task setting, a subclass, a decorator, a second caller, a different branch);
- the refutation shows the failure is unlikely or rare, not that a statement of the comment is false;
- the refutation relies on how a language, library or framework behaves, not on code in this repository.

Answer "comment_holds" when you find code that supports the comment, or when the refutation fails in one of the ways above. Answer "refutation_holds" only when you checked the code yourself and it shows that a statement the comment depends on is false. Answer "unsure" when you cannot settle it. When in doubt, do not answer "refutation_holds".

You have at most ${TETO} steps in total. Answer with submit.`,
};

function normaliza(d) {
    if (!['refutation_holds', 'comment_holds', 'unsure'].includes(d?.verdict)) throw new Error('sem resposta');
    return { nit: d.verdict === 'refutation_holds', verdict: d.verdict, evidence: d.evidence || '', reason: d.reason || '' };
}


function ferramentas(cmd) {
    return {
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

async function julga(model, cmd, s, refs) {
    const schema = SCHEMA;
    let resp = null;
    const tools = {
        ...ferramentas(cmd),
        submit: tool({ description: 'Submit your answer. Call exactly once.', inputSchema: jsonSchema(schema), execute: async (x) => { resp = x; return 'recorded'; } }),
    };
    const r = await generateText({
        model, prompt: PROMPTS[arg('prompt', 'd1')](s, refs), tools,
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now, from what you already know.' }] }
            : undefined,
    });
    return { ...normaliza(resp || extraiJson(r.text || '')), passos: r.steps?.length ?? 0 };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-alucinacao-defesa] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const fin = carregaFinal('09.10.26', GOLD);
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); };
    const SOBRE = (arg('sobre', '') || '').split(',').filter(Boolean);
    const antes = SOBRE.map((v) => JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', `aluc-${v}`, `${GOLD}.json`), 'utf8')).prs);
    const refsDe = (cid, rep) => antes.map((pr) => pr[cid]?.grupos?.find((g) => g.rep === rep)).filter((g) => g && g.nit);
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, versaoDedup: DEDUP, prs: {} };
    const fila = Object.keys(sug).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []);
            const out = [];
            if (gs.some((g) => refsDe(cid, g.rep).length)) {
                let cmd = null;
                {
                    h = await prepareRepo(vars[cid], `${cid}-nit-${process.pid}`);
                    if (!h) throw new Error('sem repo');
                    cmd = new LocalRepoCommands(h.dir);
                }
                                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < gs.length) {
                        const k = j++;
                        const refs = refsDe(cid, gs[k].rep);
                        if (!refs.length) { out[k] = { rep: gs[k].rep, membros: gs[k].membros, nit: false, verdict: 'not_refuted' }; continue; }
                        const v = await retry(() => julga(model, cmd, gs[k].s, refs));
                        out[k] = { rep: gs[k].rep, membros: gs[k].membros, ...v };
                    }
                }));
            }
            gs.forEach((g, k) => { if (!out[k]) out[k] = { rep: g.rep, membros: g.membros, nit: false, verdict: 'not_refuted' }; });
            res.prs[cid] = { grupos: out };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} comentarios, ${out.filter((x) => x.nit).length} nit`);
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
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: todos.length, nit: todos.filter((x) => x.nit).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
