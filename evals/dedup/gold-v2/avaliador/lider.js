#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Avaliador (#1821), alternativas ao atribuidor: o lider tecnico do time le os
 * comentarios que uma IA deixou no PR, sobre os mesmos grupos do dedup
 * congelado de nota.js (representante = texto mais completo). Quatro versoes:
 *   impacto   uma chamada; impacto da correcao de 1 a 5
 *   bloqueio  uma chamada; bloqueia o merge, sim ou nao
 *   ordem     loop de agente (grep/readFile/listDir no commit do PR, ate 5 passos);
 *             ordem de correcao + lista do que nao precisa ser corrigido
 *   status    loop de agente; 1 bloqueia o merge, 2 corrigir depois, 3 nao corrigir
 * Os comentarios entram embaralhados (--seed) para medir vies de posicao.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/avaliador/lider.js --versao=<v> --model=<gold model> [--seed=1] [--par=3]
 */
const fs = require('fs');
const path = require('path');
const { grupos, carregaFinal } = require('../grupos-producao');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada, extraiJson } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const VERSAO = arg('versao'), GOLD = arg('model'), SEED = Number(arg('seed', '1')), PAR = Number(arg('par', '3'));
const DEDUP = arg('dedup', 'v9-cobertura'), TETO = 5;
const MODELO = process.env.RECALL_MODEL;
const LOOP = VERSAO === 'ordem' || VERSAO === 'status';
if (!['impacto', 'bloqueio', 'ordem', 'status'].includes(VERSAO) || !GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --versao=impacto|bloqueio|ordem|status --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'lider', `${VERSAO}-s${SEED}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const int = { type: 'integer' };
const SCHEMAS = {
    impacto: { type: 'object', properties: { itens: { type: 'array', items: { type: 'object', properties: { indice: int, impacto: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['indice', 'impacto'], additionalProperties: false } } }, required: ['itens'], additionalProperties: false },
    bloqueio: { type: 'object', properties: { itens: { type: 'array', items: { type: 'object', properties: { indice: int, bloqueia: { type: 'boolean' } }, required: ['indice', 'bloqueia'], additionalProperties: false } } }, required: ['itens'], additionalProperties: false },
    ordem: { type: 'object', properties: { ordem: { type: 'array', items: int }, naoCorrigir: { type: 'array', items: int } }, required: ['ordem', 'naoCorrigir'], additionalProperties: false },
    status: { type: 'object', properties: { itens: { type: 'array', items: { type: 'object', properties: { indice: int, status: { type: 'integer', enum: [1, 2, 3] } }, required: ['indice', 'status'], additionalProperties: false } } }, required: ['itens'], additionalProperties: false },
};

const PEDIDO = {
    impacto: `For each comment, give the impact of making that fix, from 1 to 5. Your team fixes the highest-impact comments first.

  5  highest impact
  1  lowest impact`,
    bloqueio: `For each comment, decide: would you block the merge of this pull request until it is fixed? Answer true (block the merge) or false (do not block).`,
    ordem: `Put the comments in the order your team should fix them, the most important first. Comments that do not need to be fixed go in a separate list: your team will let them pass.

Every comment index goes in exactly one of the two lists.`,
    status: `Give each comment one status:

  1  blocks the merge: fix it before this pull request is merged
  2  needs to be fixed, but not now: merge, and fix it later
  3  does not need to be fixed`,
};

const prompt = (cands, diff) => `You are the tech lead of a software team. You decide what your team works on.

An AI reviewed a pull request from your team and left the comments below on it.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Comments>
${cands.map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${String(c.suggestionContent || '').slice(0, 1500)}`).join('\n\n')}
</Comments>

${PEDIDO[VERSAO]}
${LOOP ? `
You can check the repository at this pull request's commit with grep, readFile and listDir before you answer. You have at most ${TETO} steps in total; answer with submit.` : ''}
Call submit exactly once, covering every comment index.`;


/** Permutacao deterministica por PR e seed. */
function embaralha(n, chave) {
    let h = 2166136261;
    for (const ch of `${chave}:${SEED}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const p = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; const j = h % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
    return p;
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

async function loop(model, cmd, texto) {
    let resp = null;
    const tools = {
        ...ferramentas(cmd),
        submit: tool({ description: 'Submit your answer. Call exactly once.', inputSchema: jsonSchema(SCHEMAS[VERSAO]), execute: async (x) => { resp = x; return 'recorded'; } }),
    };
    const r = await generateText({
        model, prompt: texto, tools,
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now, from what you already know.' }] }
            : undefined,
    });
    return { dados: resp || extraiJson(r.text || ''), passos: r.steps?.length ?? 0, chamadas: (r.steps || []).flatMap((s) => (s.toolCalls || []).map((c) => c.toolName)).filter((n) => n !== 'submit').length };
}

/** Resposta (indices embaralhados) -> por grupo original; erro se faltar algum. */
function decodifica(dados, perm) {
    const n = perm.length, por = {};
    if (VERSAO === 'ordem') {
        const ordem = (dados?.ordem || []).map(Number), nao = (dados?.naoCorrigir || []).map(Number);
        ordem.forEach((k, pos) => { if (perm[k] !== undefined && !por[perm[k]]) por[perm[k]] = { posicao: pos + 1, naoCorrigir: false }; });
        nao.forEach((k) => { if (perm[k] !== undefined && !por[perm[k]]) por[perm[k]] = { posicao: null, naoCorrigir: true }; });
    } else {
        const campo = { impacto: 'impacto', bloqueio: 'bloqueia', status: 'status' }[VERSAO];
        for (const it of dados?.itens || []) { const k = Number(it.indice); if (perm[k] !== undefined) por[perm[k]] = { [campo]: it[campo] }; }
    }
    const falta = [...Array(n).keys()].filter((j) => !por[j]).length;
    if (falta) throw new Error(`${falta} de ${n} comentarios sem resposta`);
    return por;
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[avaliador-lider] ${VERSAO} · seed ${SEED} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const fin = carregaFinal('09.10.26', GOLD);
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); };
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, versao: VERSAO, seed: SEED, avaliador: MODELO, versaoDedup: DEDUP, prs: {} };
    const fila = Object.keys(sug).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []);
            let por = {}, meta = {};
            if (gs.length) {
                const perm = embaralha(gs.length, cid);
                const texto = prompt(perm.map((j) => gs[j].s), diffDe(vars[cid]));
                if (LOOP) {
                    h = await prepareRepo(vars[cid], `${cid}-lider-${process.pid}`);
                    if (!h) throw new Error('sem repo');
                    const cmd = new LocalRepoCommands(h.dir);
                    const r = await retry(async () => { const x = await loop(model, cmd, texto); decodifica(x.dados, perm); return x; });
                    por = decodifica(r.dados, perm); meta = { passos: r.passos, chamadas: r.chamadas };
                } else {
                    const r = await retry(async () => { const x = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema: SCHEMAS[VERSAO], prompt: texto }); decodifica(x.dados, perm); return x; });
                    por = decodifica(r.dados, perm);
                }
            }
            res.prs[cid] = { ...meta, grupos: gs.map((g, j) => ({ rep: g.rep, membros: g.membros, agentes: g.agentes, ...por[j] })) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} grupos${meta.passos ? ` · ${meta.passos} passos, ${meta.chamadas} ferramentas` : ''}`);
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
    console.log(JSON.stringify({ versao: VERSAO, seed: SEED, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, grupos: ok.reduce((a, p) => a + p.grupos.length, 0) }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
