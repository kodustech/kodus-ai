#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, ideia do Astra: etapa nova depois do verify C. Separa o comportamento
 * que o codigo de fato tem das consequencias que o comentario alega, marca as
 * consequencias que a evidencia do verify C contradiz e pergunta se, sem elas,
 * sobra um defeito concreto. Cai o comentario que tem consequencia contradita E
 * cujo resto e so opcional. Uma chamada por comentario, sem ferramentas, com o
 * claim e a evidencia do passo 1 do verify C. Escopo: singletons de lente fraca
 * que o verify C manteve.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/impacto.js --model=<gold model> --passo1=<versao> --sobre=<versao do C> --versao=<rotulo> [--prefixo=09.10.26]
 */
const fs = require('fs');
const path = require('path');

const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada } = require(path.join(INV, 'eval-structured'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), PASSO1 = arg('passo1'), SOBRE = arg('sobre'), VERSAO = arg('versao'), PREFIXO = arg('prefixo', '09.10.26');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !PASSO1 || !SOBRE || !VERSAO || !MODELO) { console.error('RECALL_MODEL=<id> --model= --passo1= --sobre= --versao='); process.exit(2); }
const OUT = path.join(__dirname, 'resultados', `aluc-${VERSAO}`, `${GOLD}.json`);
const FRACAS = new Set(['generalist-base', 'micro-exp-p3-text-that-ships', 'micro-exp-p3-test-does-not-verify']);

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['behavior', 'consequences', 'remainingDefect', 'remainingIsOptional'],
    properties: {
        behavior: { type: 'string', description: 'What the cited code actually does, as the checker notes support it.' },
        consequences: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['consequence', 'status'],
                properties: {
                    consequence: { type: 'string' },
                    status: { type: 'string', enum: ['supported', 'contradicted', 'not_checked'] },
                },
            },
        },
        remainingDefect: { type: 'string', description: 'The concrete incorrect behavior left after removing contradicted consequences, with its trigger; empty if none.' },
        remainingIsOptional: { type: 'boolean', description: 'True when what is left is only an optional improvement: nothing crashes, returns a wrong result, loses data, opens a security hole or breaks a caller.' },
    },
};

const prompt = (s, g) => `An AI code reviewer wants to post the comment below on a pull request. A checker already read the repository; its notes are below. Comments sometimes describe real code correctly but overstate what goes wrong because of it.

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

1. State what the cited code actually does, as far as the checker notes support it.
2. List each consequence the comment claims (what breaks, for whom, how badly) and mark it "contradicted" only when the checker notes show it does not happen, "supported" when they show it does, and "not_checked" otherwise. An unchecked consequence is not a contradicted one.
3. Remove the contradicted consequences. Describe the concrete incorrect behavior that is left and the input or state that triggers it. Say whether what is left is only an optional improvement: nothing crashes, returns a wrong result, loses or corrupts data, opens a security hole or breaks a caller.

Answer with submit.`;

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-impacto] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const p1 = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', `aluc-${PASSO1}`, `${GOLD}.json`), 'utf8')).prs;
    const C = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', `aluc-${SOBRE}`, `${GOLD}.json`), 'utf8')).prs;
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.json`), 'utf8')).prs;
    const res = { model: GOLD, verificador: MODELO, versao: VERSAO, sobre: SOBRE, prs: {} };
    const fila = [];
    for (const [cid, p] of Object.entries(C)) {
        if (p.erro) continue;
        const S = Object.fromEntries(sug[cid].suggestions.map((x) => [x.id, x]));
        const P1 = Object.fromEntries((p1[cid]?.grupos || []).map((g) => [g.rep, g]));
        res.prs[cid] = { grupos: p.grupos.map((g) => ({ rep: g.rep, membros: g.membros, nit: false })) };
        res.prs[cid].grupos.forEach((g, k) => {
            if (p.grupos[k].nit || g.membros.length !== 1 || !FRACAS.has(S[g.rep].producedBy)) return;
            fila.push({ g, s: S[g.rep], n: P1[g.rep] || {} });
        });
    }
    let i = 0, erros = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < fila.length) {
            const t = fila[i++];
            for (let k = 1; k <= 3; k++) {
                try {
                    const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema: SCHEMA, prompt: prompt(t.s, t.n) });
                    if (!Array.isArray(r.dados?.consequences)) throw new Error('sem resposta');
                    const contradita = r.dados.consequences.some((c) => c.status === 'contradicted');
                    t.g.julgado = r.dados;
                    t.g.nit = contradita && r.dados.remainingIsOptional === true;
                    break;
                } catch (e) {
                    if (k === 3) { erros++; t.g.erro = String(e?.message || e).slice(0, 200); }
                }
            }
        }
    }));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
    const todos = Object.values(res.prs).flatMap((p) => p.grupos);
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, julgados: fila.length, caem: todos.filter((g) => g.nit).length, erros }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
