#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: a saida do finder pelo caminho de producao ate o dedup, conferindo os
 * campos em cada etapa:
 *   finder (pool do eval) -> mapAgentFindings (poe o llmPrompt) ->
 *   parseFinderSchema -> anchoring (snapLinesToDiff) ->
 *   dedup (dedup-prompt.ts via LLM.run, com o follow-up)
 *
 * --fonte=pool:<pool>  saida nova do finder (pools/<pool>/*.raw.txt)
 * --fonte=gold         as sugestoes do gold v2 do modelo (ids S1..Sn), para
 *                      comparar o dedup com o gold (comparar-dedup.js)
 *
 * --ate=anchoring      para antes do dedup (sem chamada de modelo)
 * --sanitizador        tira, depois do parse, as sugestoes do gabarito do
 *                      sanitizador (evals/suggestion-sanitizer/dataset), como o
 *                      stage faz antes do anchoring; so com --fonte=gold
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/pipeline-ate-dedup.js --model=<gold model> --fonte=... --versao=<rotulo> [--par=4] [--ate=anchoring] [--prs=<lista.json>] [--prefixo=09.10.26]
 */
const fs = require('fs');
const path = require('path');
const { runDedup } = require('../dedup-runner');
const { buildModel } = require('../../investigation/eval-model');
const { TIER0 } = require('../../shared/tier0-models');
const { mapAgentFindings } = require('@libs/code-review/infrastructure/agents/collaborators/finding-mapper');
const { parseFinderSchema, LEAN_FINDER_FIELDS } = require('@libs/code-review/infrastructure/agents/engine/parse-finder-schema');
const { buildDedupPrompt } = require('@libs/code-review/infrastructure/agents/engine/dedup-prompt');
const { snapLinesToDiff } = require('@libs/code-review/pipeline/stages/agent-review.stage');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), FONTE = arg('fonte'), VERSAO = arg('versao'), PAR = Number(arg('par', '4'));
const SO_ANCHORING = arg('ate') === 'anchoring';
const SANITIZA = process.argv.includes('--sanitizador');
const SEM_PROBLEMA = SANITIZA
    ? JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'suggestion-sanitizer', 'dataset', `${GOLD}.json`), 'utf8')).semProblema
    : {};
const MODELO = process.env.RECALL_MODEL || (SO_ANCHORING ? '-' : undefined);
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
            arquivos[c.vars.caseId] = (typeof cf === 'string' ? JSON.parse(cf) : cf).map((x) => ({ filename: x.filename, ranges: validRanges(x.patchWithLinesStr) }));
        }
    }
}
// Linhas do lado direito do diff, como extractValidDiffLines tira do patch cru;
// o dataset traz o patchWithLinesStr (mesma conversao de evals/anchoring).
function validRanges(patchWithLinesStr) {
    const ranges = [];
    let cur = null;
    for (const ln of String(patchWithLinesStr || '').split('\n')) {
        const m = /^(__old hunk__|__new hunk__|@@ |## file:)/.test(ln) ? null : ln.match(/^\s*(\d+)\s/);
        if (!m) { if (cur) { ranges.push(cur); cur = null; } continue; }
        const n = +m[1];
        if (cur && n === cur[1] + 1) cur[1] = n;
        else { if (cur) ranges.push(cur); cur = [n, n]; }
    }
    if (cur) ranges.push(cur);
    return ranges;
}
const distancia = (s, ranges) => Math.min(...ranges.map(([a, b]) => (s.relevantLinesEnd < a ? a - s.relevantLinesEnd : s.relevantLinesStart > b ? s.relevantLinesStart - b : 0)));
const LABEL_POLICY = { categoryLabel: 'generalist', allowedLabels: ['bug', 'security', 'performance'], supportsMixed: true };
const conta = (lista) => lista.reduce((m, s) => { for (const k of Object.keys(s)) m[k] = (m[k] || 0) + 1; return m; }, {});

(async () => {
    const assinatura = !SO_ANCHORING && ['codex_subscription', 'claude_agent_sdk'].includes(TIER0[MODELO]?.provider);
    const prebuilt = assinatura ? buildModel(MODELO) : undefined;
    // --prs: lista de PRs (json) no lugar do light-30.
    const L30 = JSON.parse(fs.readFileSync(arg('prs', path.join(INV, 'light-30.json')), 'utf8'));
    const gold = FONTE === 'gold' ? JSON.parse(fs.readFileSync(path.join(__dirname, `${arg('prefixo', '09.10.26')}_${GOLD}.json`), 'utf8')).prs : null;
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
            const idParse = origem.filter((_, j) => !descParse.has(j)).map((k) => ids[k]);
            // Anchoring como no stage: arquivo fora do diff ou sem trecho passa igual.
            const porArquivo = new Map(arquivos[cid].map((f) => [f.filename, f.ranges]));
            const entrada = [];
            const idEntrada = [];
            const descartadoAnchoring = [];
            let ajustadoAnchoring = 0;
            const descartadoSanitizador = [];
            parsed.suggestions.forEach((s, j) => {
                if ((SEM_PROBLEMA[cid] || []).includes(idParse[j])) { descartadoSanitizador.push(idParse[j]); return; }
                const ranges = porArquivo.get(s.relevantFile);
                const snapped = ranges ? snapLinesToDiff(s, ranges) : s;
                if (snapped === null) {
                    descartadoAnchoring.push({ id: idParse[j], arquivo: s.relevantFile, linhas: [s.relevantLinesStart, s.relevantLinesEnd], distancia: distancia(s, ranges) });
                    return;
                }
                if (snapped.relevantLinesStart !== s.relevantLinesStart || snapped.relevantLinesEnd !== s.relevantLinesEnd) ajustadoAnchoring++;
                entrada.push(snapped);
                idEntrada.push(idParse[j]);
            });
            const op = { guard: 'record', prebuiltModel: prebuilt };
            const r = SO_ANCHORING || !entrada.length ? { groups: [], unique: [], unmentioned: [] } : await runDedup(entrada, MODELO, op);
            const id = (k) => idEntrada[k];
            const promptDedup = buildDedupPrompt(entrada);
            res.prs[cid] = {
                n: finder.length,
                camposFinder: conta(finder),
                descartadoConversor: finder.map((_, k) => k).filter((k) => !origem.includes(k)).map((k) => ids[k]),
                camposConversor: conta(mapeado),
                descartadoParse: parsed.discarded.map((d) => ({ id: ids[origem[d.index]], faltando: d.missing })),
                descartadoSanitizador,
                descartadoAnchoring,
                ajustadoAnchoring,
                camposDedup: conta(entrada),
                llmPromptNoPromptDoDedup: entrada.some((s) => s.llmPrompt && s.llmPrompt !== s.suggestionContent && promptDedup.includes(s.llmPrompt)),
                entradaDedup: entrada.length,
                idsEntradaDedup: idEntrada,
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
