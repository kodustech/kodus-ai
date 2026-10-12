#!/usr/bin/env node
/**
 * Suggestion sanitizer eval (#1821): runs the production sanitizer prompt
 * (engine/suggestion-sanitizer-prompt.ts) through LLM.run on the frozen finder
 * output of one model (evals/dedup/gold-v2/09.10.26_<model>.json), one call per
 * PR, and compares what it discards with dataset/<model>.json. The target is
 * exact: every listed suggestion discarded and nothing else. A model with no
 * no-problem suggestions has an empty dataset, so any discard is a failure.
 *
 *   RECALL_MODEL=<tier0 id> node evals/suggestion-sanitizer/run.js --model=<gold model> --versao=<label> [--par=4]
 *
 * Exit 0 exact on every PR measured, 1 mismatch, 2 infra (a PR not measured).
 */
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });

const { jsonSchema } = require('ai');
const { TIER0, applyModelEnv } = require('../shared/tier0-models');
const { buildModel } = require('../investigation/eval-model');
const { parseFinderSchema } = require('@libs/code-review/infrastructure/agents/engine/parse-finder-schema');
const { buildSanitizerPrompt, SANITIZER_SCHEMA, sanitizerDiscardIndices } = require('@libs/code-review/infrastructure/agents/engine/suggestion-sanitizer-prompt');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), VERSAO = arg('versao'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !VERSAO || !MODELO || !TIER0[MODELO]) { console.error('RECALL_MODEL=<tier0 id> --model=<gold model> --versao=<label>'); process.exit(2); }

const fonte = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup', 'gold-v2', `09.10.26_${GOLD}.json`), 'utf8')).prs;
const dataset = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset', `${GOLD}.json`), 'utf8'));
const OUT = path.join(__dirname, 'results', VERSAO, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

(async () => {
    applyModelEnv(MODELO);
    const { LLM } = require('@libs/llm/llm');
    const assinatura = ['codex_subscription', 'claude_agent_sdk'].includes(TIER0[MODELO].provider);
    const prebuilt = assinatura ? buildModel(MODELO) : undefined;
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, sanitizerModel: MODELO, prs: {} };
    const fila = Object.keys(fonte).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        // Como no stage: o sanitizador recebe o que passou pelo parse schema.
        const todas = fonte[cid].suggestions;
        const parsed = parseFinderSchema(todas);
        const fora = new Set(parsed.discarded.map((d) => d.index));
        const sugs = todas.filter((_, k) => !fora.has(k));
        try {
            const r = sugs.length
                ? await LLM.run({
                      schema: jsonSchema(SANITIZER_SCHEMA),
                      user: buildSanitizerPrompt(sugs),
                      runName: 'code-review-suggestion-sanitizer',
                      spanName: 'code-review::suggestion-sanitizer',
                      ...(prebuilt ? { prebuiltModel: prebuilt } : {}),
                  })
                : { discard: [] };
            const descartou = sanitizerDiscardIndices(sugs.length, r).map((k) => sugs[k].id);
            const esperado = (dataset.semProblema[cid] || []).filter((x) => sugs.some((s) => s.id === x));
            res.prs[cid] = {
                n: sugs.length,
                descartadasNoParse: todas.filter((_, k) => fora.has(k)).map((s) => s.id),
                esperado,
                descartou,
                aMais: descartou.filter((x) => !esperado.includes(x)),
                aMenos: esperado.filter((x) => !descartou.includes(x)),
            };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const soma = (k) => ok.reduce((a, p) => a + p[k].length, 0);
    const resumo = { model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, esperado: soma('esperado'), descartou: soma('descartou'), aMais: soma('aMais'), aMenos: soma('aMenos') };
    console.log(JSON.stringify(resumo));
    if (resumo.erros) { console.error(`not measured: ${resumo.erros} PR(s) failed (see ${OUT})`); process.exit(2); }
    process.exit(resumo.aMais || resumo.aMenos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
