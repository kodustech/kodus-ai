#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * H7 (#1821): diagnostico, nao derruba nada. Uma chamada por comentario, sem
 * ferramentas, pede as premissas necessarias do defeito e do impacto. Roda nas
 * alucinacoes que sobrevivem ao verify C e numa amostra pareada (mesmo conjunto)
 * de TPs e bugs reais que tambem sobrevivem, sem mostrar o rotulo. Depois se
 * confere a mao se a premissa falsa (a `evidencia` do rotulo) aparece na lista.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/h7.js --model=<gold model> --conjuntos=m13l:gold-v2,m13h:holdout-20 [--controles=1]
 */
const fs = require('fs');
const path = require('path');

const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel } = require(path.join(INV, 'eval-model'));
const { chamadaEstruturada } = require(path.join(INV, 'eval-structured'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), MODELO = process.env.RECALL_MODEL;
const CONJ = arg('conjuntos').split(',').map((x) => x.split(':'));
const CONTROLES = Number(arg('controles', '1'));
const OUT = path.join(__dirname, 'resultados', 'h7', `${GOLD}.json`);

const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['defect', 'premises'],
    properties: {
        defect: { type: 'string' },
        premises: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['premise', 'kind', 'neededFor', 'check'],
                properties: {
                    premise: { type: 'string' },
                    kind: { type: 'string', enum: ['repository_fact', 'language_or_tool_semantics', 'history_of_the_change', 'runtime_assumption'] },
                    neededFor: { type: 'string', enum: ['defect', 'impact'] },
                    check: { type: 'string' },
                },
            },
        },
    },
};

const prompt = (s) => `An AI code reviewer wants to post the comment below on a pull request. Do not judge whether it is right. List what must be true for it to be right.

<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>

1. State in one sentence the defect the comment reports.
2. List every atomic premise that must hold for the defect to exist and for the impact it claims. Include the ones the comment takes for granted without saying: that a caller, file, override or setting exists; that the code at the cited lines does what it says; that the pull request introduced or changed the behavior; how the language, a library or a tool behaves; which state or input can reach the code at runtime.
For each premise give its kind (repository_fact, language_or_tool_semantics, history_of_the_change, runtime_assumption), whether it is needed for the defect itself or only for the claimed impact, and the concrete check that would confirm or refute it (a search, a file to read, a snippet to run, a diff to look at).

Answer with submit.`;

(async () => {
    const model = buildModel(MODELO);
    const fila = [];
    for (const [pref, base] of CONJ) {
        const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${pref}_${GOLD}.json`), 'utf8')).prs;
        const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', `aluc-${pref}-h1t10f`, `${GOLD}.json`), 'utf8')).prs;
        const dirRot = path.join(__dirname, '..', '..', base, 'classificacao', GOLD);
        const aluc = [], tp = [], br = [];
        for (const f of fs.readdirSync(dirRot)) {
            const d = JSON.parse(fs.readFileSync(path.join(dirRot, f), 'utf8'));
            const C = Object.fromEntries(d.itens.map((x) => [x.id, x]));
            for (const g of R[d.caseId]?.grupos || []) {
                if (g.nit) continue;
                const mem = g.membros.map((s) => C[s]);
                const rep = C[g.rep];
                const item = { conjunto: pref, caseId: d.caseId, id: g.rep, s: sug[d.caseId].suggestions.find((x) => x.id === g.rep), rotulo: { classe: rep.classe, tipoFP: rep.tipoFP, evidencia: rep.evidencia } };
                if (mem.some((x) => x.classe === 'TP')) { if (rep.classe === 'TP') tp.push(item); }
                else if (rep.tipoFP === 'alucinacao') aluc.push(item);
                else if (rep.tipoFP === 'bug_real') br.push(item);
            }
        }
        // Controles: TPs e bugs reais do mesmo conjunto, ordem fixa (por caseId/id), na proporcao das alucinacoes.
        const ordem = (a) => a.sort((x, y) => (x.caseId + x.id).localeCompare(y.caseId + y.id));
        const passo = (a, n) => { ordem(a); const k = Math.max(1, Math.floor(a.length / Math.max(1, n))); return a.filter((_, i) => i % k === 0).slice(0, n); };
        fila.push(...aluc.map((x) => ({ ...x, grupo: 'alucinacao' })));
        if (CONTROLES) {
            fila.push(...passo(tp, aluc.length).map((x) => ({ ...x, grupo: 'tp' })));
            fila.push(...passo(br, Math.ceil(aluc.length / 2)).map((x) => ({ ...x, grupo: 'bug_real' })));
        }
    }
    const res = { model: GOLD, modelo: MODELO, itens: [] };
    let i = 0, erros = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < fila.length) {
            const t = fila[i++];
            for (let k = 1; k <= 3; k++) {
                try {
                    const r = await chamadaEstruturada({ model, modelId: MODELO, nome: 'submit', schema: SCHEMA, prompt: prompt(t.s) });
                    if (!Array.isArray(r.dados?.premises)) throw new Error('sem premissas');
                    const { s, ...resto } = t;
                    res.itens.push({ ...resto, comentario: s.suggestionContent, arquivo: `${s.relevantFile}:${s.relevantLinesStart}`, saida: r.dados });
                    break;
                } catch (e) {
                    if (k === 3) { erros++; console.error(t.caseId, t.id, String(e?.message || e).slice(0, 200)); }
                }
            }
        }
    }));
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
    const n = (g) => res.itens.filter((x) => x.grupo === g).length;
    console.log(JSON.stringify({ alucinacao: n('alucinacao'), tp: n('tp'), bug_real: n('bug_real'), erros }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
