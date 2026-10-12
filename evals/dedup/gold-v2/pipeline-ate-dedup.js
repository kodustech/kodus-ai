#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: a saida do finder pelo caminho de producao ate o dedup, conferindo os
 * campos em cada etapa:
 *   finder (pool do eval) -> mapAgentFindings (poe o llmPrompt) ->
 *   parseFinderSchema -> dedup (dedup-prompt.ts via LLM.run, com o follow-up)
 *
 * --fonte=pool:<pool>  saida nova do finder (pools/<pool>/*.raw.txt)
 * --fonte=gold         as sugestoes do gold v2 do modelo (ids S1..Sn), para
 *                      comparar o dedup com o gold (comparar-dedup.js)
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/pipeline-ate-dedup.js --model=<gold model> --fonte=... --versao=<rotulo> [--par=4]
 */
const fs = require('fs');
const path = require('path');
const { runDedup } = require('../dedup-runner');
const { buildModel } = require('../../investigation/eval-model');
const { TIER0 } = require('../../shared/tier0-models');
const { mapAgentFindings } = require('@libs/code-review/infrastructure/agents/collaborators/finding-mapper');
const { parseFinderSchema, LEAN_FINDER_FIELDS } = require('@libs/code-review/infrastructure/agents/engine/parse-finder-schema');
const { buildDedupPrompt } = require('@libs/code-review/infrastructure/agents/engine/dedup-prompt');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), FONTE = arg('fonte'), VERSAO = arg('versao'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !FONTE || !VERSAO || !MODELO) { console.error('RECALL_MODEL=<id> --model= --fonte=pool:<pool>|gold --versao='); process.exit(2); }
const INV = path.join(__dirname, '..', '..', 'investigation');
const OUT = path.join(__dirname, 'dedup-real', VERSAO, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// Arquivos alterados de cada caso, como o conversor de producao recebe.
const arquivos = {};
for (const f of fs.readdirSync(path.join(INV, 'datasets'))) {
    let casos = [];
    try { casos = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8')); } catch { continue; }
    for (const c of casos) {
        if (c?.vars?.caseId) {
            // O diff completo (changedFilesFull), o mesmo que o finder do eval recebe.
            const cf = c.vars.changedFilesFull || c.vars.changedFiles || [];
            arquivos[c.vars.caseId] = (typeof cf === 'string' ? JSON.parse(cf) : cf).map((x) => ({ filename: x.filename }));
        }
    }
}
const LABEL_POLICY = { categoryLabel: 'generalist', allowedLabels: ['bug', 'security', 'performance'], supportsMixed: true };
const conta = (lista) => lista.reduce((m, s) => { for (const k of Object.keys(s)) m[k] = (m[k] || 0) + 1; return m; }, {});

(async () => {
    const assinatura = ['codex_subscription', 'claude_agent_sdk'].includes(TIER0[MODELO]?.provider);
    const prebuilt = assinatura ? buildModel(MODELO) : undefined;
    const L30 = JSON.parse(fs.readFileSync(path.join(INV, 'light-30.json'), 'utf8'));
    const gold = FONTE === 'gold' ? JSON.parse(fs.readFileSync(path.join(__dirname, `09.10.26_${GOLD}.json`), 'utf8')).prs : null;
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, dedupModel: MODELO, fonte: FONTE, prs: {} };
    const fila = L30.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            if (!arquivos[cid]) throw new Error('caso sem changedFiles em datasets/');
            const finder = gold
                ? gold[cid].suggestions.map((s) => { const { id, finderIndex, technique, ...r } = s; return r; })
                : JSON.parse(fs.readFileSync(path.join(INV, 'pools', FONTE.slice(5), `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const ids = gold ? gold[cid].suggestions.map((s) => s.id) : finder.map((_, k) => `S${k + 1}`);
            // O conversor descarta sugestao de arquivo fora do PR; guarda o indice original.
            const mapeado = [];
            const origem = [];
            finder.forEach((s, k) => {
                const m = mapAgentFindings({ findings: { suggestions: [s] } }, {
                    changedFiles: arquivos[cid], prNumber: 0, isKodyRules: false, identityName: 'pipeline-ate-dedup', labelPolicy: LABEL_POLICY,
                }).suggestions;
                if (m.length) { mapeado.push(m[0]); origem.push(k); }
            });
            const parsed = parseFinderSchema(mapeado);
            const descParse = new Set(parsed.discarded.map((d) => d.index));
            const entrada = parsed.suggestions;
            const idEntrada = origem.filter((_, j) => !descParse.has(j)).map((k) => ids[k]);
            const op = { guard: 'record', prebuiltModel: prebuilt };
            const r = entrada.length ? await runDedup(entrada, MODELO, op) : { groups: [], unique: [], unmentioned: [] };
            const id = (k) => idEntrada[k];
            const promptDedup = buildDedupPrompt(entrada);
            res.prs[cid] = {
                n: finder.length,
                camposFinder: conta(finder),
                descartadoConversor: finder.map((_, k) => k).filter((k) => !origem.includes(k)).map((k) => ids[k]),
                camposConversor: conta(mapeado),
                descartadoParse: parsed.discarded.map((d) => ({ id: ids[origem[d.index]], faltando: d.missing })),
                camposDedup: conta(entrada),
                llmPromptNoPromptDoDedup: entrada.some((s) => s.llmPrompt && s.llmPrompt !== s.suggestionContent && promptDedup.includes(s.llmPrompt)),
                entradaDedup: entrada.length,
                groups: (r.groups || []).map((g) => ({ keep: id(g.keep), duplicates: (g.duplicates || []).map(id).filter(Boolean) })),
                unique: (r.unique || []).map(id).filter(Boolean),
                unmentioned: (r.unmentioned || []).map(id),
                followup: r.followup ? { leftOut: r.followup.leftOut.map(id), stillLeftOut: (r.followup.stillLeftOut || []).map(id), ...(r.followup.erro ? { erro: r.followup.erro } : {}) } : null,
                pares: (op.pairs || []).map((p) => ({ dup: id(p.idx), keep: id(p.keptInto), lex: p.lex, cos: p.cos, tb: p.tb })),
                campos5: LEAN_FINDER_FIELDS,
            };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    console.log(JSON.stringify({ model: GOLD, fonte: FONTE, prs: ok.length, erros: Object.keys(res.prs).length - ok.length }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
