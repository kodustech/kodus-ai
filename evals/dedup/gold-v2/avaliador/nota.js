#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Avaliador (#1821), fase 1: o atribuidor (a pergunta dos dez devs donos do
 * codigo, nota 0-100; mesmo prompt de investigation/seletor-nota.js) sobre o
 * dedup congelado. Um comentario por grupo do gold v2, so com as sugestoes que
 * chegam ao dedup na rodada de producao (dedup-real/<versao>: parse, sanitizador
 * e anchoring ja aplicados). Representante: o texto mais completo do grupo,
 * como pede a regra de cobertura do dedup. Cada modelo pontua as proprias.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/avaliador/nota.js --model=<gold model> [--versao=v9-cobertura] [--par=4]
 */
const fs = require('fs');
const path = require('path');
const { grupos, carregaFinal } = require('../grupos-producao');
const { tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada } = require(path.join(INV, 'eval-structured'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), VERSAO = arg('versao', 'v9-cobertura'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
// --apos=<resultado do verify> (ex.: aluc-h1t10f): so os grupos que o verify manteve.
const APOS = arg('apos');
// --extra=impacto|urgente: um campo a mais por comentario, na mesma chamada. --prs=N: so os N primeiros PRs.
const EXTRA = arg('extra'), MAXPRS = Number(arg('prs', '0'));
// --modo=devs|niveis: em vez da contagem, um array de 10 devs por comentario. --rodada=N separa repeticoes.
const MODO = arg('modo'), RODADA = arg('rodada');
const OUT = path.join(__dirname, 'notas', `${GOLD}${APOS ? `__${APOS}` : ''}${EXTRA ? `__${EXTRA}` : ''}${MODO ? `__${MODO}` : ''}${RODADA ? `__r${RODADA}` : ''}.json`);
const NIVEIS = MODO === 'niveis';
const PESO = { expert: 2, senior: 1.5, mid: 1.25, junior: 0 };
const DEV = {
    type: 'object',
    properties: {
        ...(NIVEIS ? { level: { type: 'string', enum: ['expert', 'senior', 'mid', 'junior'] } } : {}),
        wouldFix: { type: 'boolean' },
        impact: { type: 'string', enum: ['low', 'medium', 'high'] },
        urgent: { type: 'boolean' },
        justify: { type: 'string', description: 'One sentence.' },
    },
    required: [...(NIVEIS ? ['level'] : []), 'wouldFix', 'impact', 'urgent', 'justify'],
    additionalProperties: false,
};
/** Nota 0-100 a partir do array de devs (niveis: ponderada, junior fora). */
function notaDosDevs(devs) {
    if (!Array.isArray(devs) || devs.length !== 10) return null;
    if (!NIVEIS) return devs.filter((d) => d.wouldFix).length * 10;
    const max = devs.reduce((a, d) => a + (PESO[d.level] ?? 0), 0);
    return max ? Math.round((devs.reduce((a, d) => a + (d.wouldFix ? PESO[d.level] ?? 0 : 0), 0) / max) * 1000) / 10 : null;
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const SCHEMA_DEVS = {
    type: 'object',
    properties: {
        notas: {
            type: 'array',
            items: {
                type: 'object',
                properties: { indice: { type: 'number' }, devs: { type: 'array', items: DEV, minItems: 10, maxItems: 10 } },
                required: ['indice', 'devs'],
                additionalProperties: false,
            },
        },
    },
    required: ['notas'],
    additionalProperties: false,
};
const SCHEMA_NOTA = {
    type: 'object',
    properties: {
        notas: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    nota: { type: 'number', description: '0-100: quantos dos dez mudariam o codigo, vezes dez.' },
                    porque: { type: 'string', description: 'Uma frase, citando file:line.' },
                    ...(process.argv.some((a) => a === '--extra=impacto') ? { impacto: { type: 'string', enum: ['low', 'medium', 'high'] } } : {}),
                    ...(process.argv.some((a) => a === '--extra=urgente') ? { urgente: { type: 'boolean' } } : {}),
                },
                required: ['indice', 'nota', 'porque', ...(process.argv.some((a) => a === '--extra=impacto') ? ['impacto'] : []), ...(process.argv.some((a) => a === '--extra=urgente') ? ['urgente'] : [])],
                additionalProperties: false,
            },
        },
    },
    required: ['notas'],
    additionalProperties: false,
};
const SCHEMA = MODO ? SCHEMA_DEVS : SCHEMA_NOTA;
const pontuarTool = tool({ description: 'Registra a nota de cada candidato. Chame exatamente uma vez.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });

// Mesmo texto de investigation/seletor-nota.js; a saida enxuta nao tem
// oneSentenceSummary nem reason, entao essas linhas ficam de fora.
const prompt = (cands, diff) => `A review of this pull request produced the findings below. Your job is to say how much each one is worth posting.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Candidates>
${cands
    .map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${String(c.suggestionContent || '').slice(0, 500)}`)
    .join('\n\n')}
</Candidates>

Give each candidate 0-100: how much is it worth posting this, on this pull request,
to the developer who wrote it.

Imagine ten experienced developers who own this codebase and know it well.
They each read this pull request and this comment. How many of the ten would
CHANGE THE CODE because of it, before merging?

Answer with that count times ten: 0, 10, 20 ... 100.

  100  all ten would change the code — the defect is plain and it matters
  70   seven would; three would argue it is fine as is
  40   four would; the rest would merge and maybe open a follow-up
  10   one might; nine would read past it
  0    none would — they know why this is fine, or the claim is wrong

Answer for the developers who OWN this code, not for a careful outsider. They
know the conventions, they know what is intentional, and they know what the
next commit already handles.

Judge the defect, not the prose. Do not reward a confident tone, and do not
punish a terse one. A real defect described badly still scores high.

Be honest with the low end. This pull request does not owe you findings: if
most of these candidates are noise, most of the scores should be below 40.

${MODO ? `Answer as each of the ten developers, one by one, for every candidate.${NIVEIS ? ' The ten are three experts (principal engineers who know this codebase in depth), three seniors, three mid-level developers and one junior; give each one\'s level.' : ''} They are different people and may disagree. For each developer give:
  wouldFix  true if this developer would change the code because of it before merging
  impact    low, medium or high: how much the fix matters to this codebase and its users
  urgent    true if this developer would fix it before this pull request merges, false if it can wait
  justify   one sentence on why this developer would or would not change the code

Give exactly ten developers per candidate. Instead of a single score, the devs array is your answer.

` : ''}${EXTRA === 'impacto' ? `Also give each candidate its impact: how much the fix matters to this codebase and its users, judged on its own, not against the other candidates.

  high    the fix prevents a real failure that users or other code would hit
  medium  the fix matters, but the failure is limited or uncommon
  low     the fix is minor or cosmetic

` : ''}${EXTRA === 'urgente' ? `Also say for each candidate whether the fix is urgent: true when the owners would fix it before this pull request merges, false when it can wait for a later change or never. Judge each candidate on its own.

` : ''}Call pontuar exactly once, with ${MODO ? 'the ten developers' : 'a score'} for every candidate index.`;


(async () => {
    const model = buildModel(MODELO);
    console.log(`[avaliador-nota] ${descreveModelo(MODELO)} · ${GOLD} · ${VERSAO}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `09.10.26_${GOLD}.json`), 'utf8')).prs;
    const fin = carregaFinal('09.10.26', GOLD);
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', VERSAO, `${GOLD}.json`), 'utf8')).prs;
    const diffs = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n');
        } catch {}
    }
    const removidos = new Set();
    if (APOS) {
        const ver = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'verify', 'resultados', APOS, `${GOLD}.json`), 'utf8')).prs;
        for (const [c, p] of Object.entries(ver)) for (const g of p.grupos || []) if (g.nit) removidos.add(`${c}|${g.rep}`);
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, atribuidor: MODELO, versaoDedup: VERSAO, prs: {} };
    const fila = Object.keys(sug).slice(0, MAXPRS || undefined).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []).filter((g) => !removidos.has(`${cid}|${g.rep}`));
            let notas = [];
            if (gs.length) {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'pontuar', schema: SCHEMA, toolDef: pontuarTool, prompt: prompt(gs.map((g) => g.s), diffs[cid]) }));
                notas = r.dados?.notas || [];
            }
            const por = Object.fromEntries(notas.map((n) => [Number(n.indice), n]));
            if (MODO) for (const n of Object.values(por)) n.nota = notaDosDevs(n.devs);
            const falta = gs.filter((_, j) => !por[j] || por[j].nota == null || Number.isNaN(Number(por[j].nota))).length;
            if (falta) throw new Error(`${falta} grupos sem nota`);
            res.prs[cid] = { grupos: gs.map((g, j) => ({ rep: g.rep, membros: g.membros, agentes: g.agentes, nota: Number(por[j].nota), porque: por[j].porque, ...(EXTRA ? { [EXTRA]: por[j][EXTRA] } : {}), ...(MODO ? { devs: por[j].devs } : {}) })) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} grupos`);
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${res.prs[cid].erro}`);
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    console.log(JSON.stringify({ model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, grupos: ok.reduce((a, p) => a + p.grupos.length, 0) }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
