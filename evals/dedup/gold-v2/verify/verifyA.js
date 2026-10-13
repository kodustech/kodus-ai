#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Verify A (#1821) sobre os grupos do dedup congelado: o verify de producao
 * (refutar para derrubar) com o diff do PR na frente, teto 10, como
 * investigation/verify-etapa3.js --variante=a10l. Derrubar so vale se a sessao
 * leu o arquivo citado, e uma segunda sessao independente tem de concordar.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/verifyA.js --model=<gold model> [--versao=A] [--par=3]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { extraiJson } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));
const { buildVerifierPrompt } = require('../../../../libs/code-review/infrastructure/agents/prompts/verifier-prompt.ts');
const { bundleFor } = require('../../../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), VERSAO = arg('versao', 'A'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const TETO = 10;
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `verify-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
const mesmoArquivo = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.endsWith('/' + b) || b.endsWith('/' + a)); };
const SYSTEM = buildVerifierPrompt('', 0).system.replace('- You may use only a few tool calls. Be surgical.\n', '');
const PASSOS = `You have up to ${TETO} steps. The LAST one is your verdict — submitting is itself a step — so you have up to ${TETO - 1} to investigate with.

Recommended approach:
1. Read the cited file/range.
2. Search for the key symbol or caller if the claim depends on flow.
3. Read the relevant caller/callee files.
4. Submit your verdict with submitVerdict.`;
const prompt = (c, diff) => `<PullRequestDiff>\n${diff}\n</PullRequestDiff>\n\n${bundleFor(c).split('\n').filter((l) => !l.startsWith('Severity:')).join('\n')}\n\n${PASSOS}\n\nSubmit your verdict with submitVerdict: {"keep": true|false, "rationale": "why the evidence supports keep/drop"}. keep=true unless you can REFUTE it.`;

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

function ferramentas(cmd, lidos) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => String(await cmd.grep(pattern, p, glob)).slice(0, 6000),
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { lidos.push(p); const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); },
        }),
    };
}

async function sessao(model, cmd, c, diff) {
    let v = null;
    const lidos = [];
    const tools = { ...ferramentas(cmd, lidos), submitVerdict: tool({ description: 'Submit your verdict. The only way to answer.', inputSchema: jsonSchema({ type: 'object', properties: { keep: { type: 'boolean' }, rationale: { type: 'string' } }, required: ['keep', 'rationale'] }), execute: async (x) => { v = x; return 'verdict recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM, prompt: prompt(c, diff), tools,
        stopWhen: (x) => !!v || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitVerdict'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitVerdict' } }),
                messages: [...messages, { role: 'user', content: 'You are at the final step. Submit your verdict now, from the evidence you already have.' }] }
            : undefined,
    });
    if (!v) v = extraiJson(r.text || '');
    const tem = typeof v?.keep === 'boolean';
    return { keep: tem ? v.keep : true, temVeredito: tem, passos: r.steps?.length ?? 0, leuCitado: lidos.some((p) => mesmoArquivo(p, c.relevantFile)), rationale: String(v?.rationale || '').slice(0, 600) };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-A] ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const fin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.final.json`), 'utf8')).prs;
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); };
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, versaoDedup: DEDUP, prs: {} };
    const fila = Object.keys(sug).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []);
            const out = [];
            if (gs.length) {
                h = await prepareRepo(vars[cid], `${cid}-vA-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                const diff = diffDe(vars[cid]);
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < gs.length) {
                        const k = j++;
                        const v1 = await retry(() => sessao(model, cmd, gs[k].s, diff));
                        const v2 = !v1.keep && v1.leuCitado ? await retry(() => sessao(model, cmd, gs[k].s, diff)) : null;
                        const derruba = !v1.keep && v1.leuCitado && v2 && !v2.keep && v2.leuCitado;
                        out[k] = { rep: gs[k].rep, membros: gs[k].membros, nit: !!derruba, v1, v2 };
                    }
                }));
            }
            res.prs[cid] = { grupos: out };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} comentarios, ${out.filter((x) => x.nit).length} derrubados`);
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
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: todos.length, derrubados: todos.filter((x) => x.nit).length, dropBruto: todos.filter((x) => !x.v1.keep).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
