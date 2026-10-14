#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Gold de duplicatas v2 (#1821): roda o dedup de PRODUCAO (dedup-prompt.ts via
 * LLM.run, o mesmo do agent-review.stage) sobre as sugestoes do gold, no modelo
 * do cenario, e grava os grupos com os ids S1..Sn do gold.
 *
 * guard 'record': a fusao proposta pelo LLM fica toda gravada com o score
 * lexico, o cosseno do embedding e o veredito do desempate de cada par, para
 * comparar com o gold tanto a saida crua do LLM quanto a saida depois do guarda
 * de producao (comparar-dedup.js).
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/dedup-real.js --model=<gold model> --versao=<rotulo do prompt> [--par=4] [--only=a,b]
 */
const fs = require('fs');
const path = require('path');
const { runDedup } = require('../dedup-runner');
const { buildModel } = require('../../investigation/eval-model');
const { TIER0 } = require('../../shared/tier0-models');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model');
const PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const VERSAO = arg('versao');
if (!VERSAO) { console.error('--versao=<rotulo do prompt>'); process.exit(2); }
const OUT = path.join(__dirname, 'dedup-real', VERSAO, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

(async () => {
    const assinatura = ['codex_subscription', 'claude_agent_sdk'].includes(TIER0[MODELO]?.provider);
    const prebuilt = assinatura ? buildModel(MODELO) : undefined;
    const gold = JSON.parse(fs.readFileSync(path.join(__dirname, `${arg('prefixo', '09.10.26')}_${GOLD}.json`), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, dedupModel: MODELO, prs: {} };
    const SO = (arg('only', '') || '').split(',').filter(Boolean);
    const fila = Object.keys(gold.prs).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        try {
            const sug = gold.prs[cid].suggestions;
            const op = { guard: 'record', prebuiltModel: prebuilt };
            const r = await runDedup(sug, MODELO, op);
            const id = (k) => sug[k]?.id;
            res.prs[cid] = {
                n: sug.length,
                groups: (r.groups || []).map((g) => ({ keep: id(g.keep), duplicates: (g.duplicates || []).map(id).filter(Boolean) })),
                unique: (r.unique || []).map(id).filter(Boolean),
                unmentioned: (r.unmentioned || []).map(id),
                followup: r.followup ? { leftOut: r.followup.leftOut.map(id), stillLeftOut: (r.followup.stillLeftOut || []).map(id), ...(r.followup.erro ? { erro: r.followup.erro } : {}) } : null,
                pares: (op.pairs || []).map((p) => ({ dup: id(p.idx), keep: id(p.keptInto), lex: p.lex, cos: p.cos, tb: p.tb })),
            };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    console.log(JSON.stringify({ model: GOLD, dedupModel: MODELO, prs: ok.length, erros: Object.keys(res.prs).length - ok.length }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
