#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: o dedup de PRODUCAO (dedup-prompt.ts via LLM.run, o mesmo do
 * agent-review.stage) sobre o heavy sem verify (G + M3, mantidos + derrubados),
 * no modelo do cenario. Fusao so vale com semelhanca de texto >= limiar
 * (guard 'content'): e o caminho que a producao segue quando nao ha embedding.
 * Grava os comentarios que sobram, para a medicao pela regua da Martian.
 *
 *   RECALL_MODEL=<id> node dedup-producao.js --sufixo= --poolsv=<pool>-heavysv --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { runDedup } = require('../dedup/dedup-runner');
const { buildModel } = require('./eval-model');
const { TIER0 } = require('../shared/tier0-models');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const SUFIXO = arg('sufixo'), POOLSV = arg('poolsv'), OUT = arg('out'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
const assinatura = TIER0[MODELO]?.provider === 'codex_subscription';
(async () => {
    const prebuilt = assinatura ? buildModel(MODELO) : undefined;
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const cands = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', POOLSV, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const r = await runDedup(cands, MODELO, { guard: 'content', prebuiltModel: prebuilt });
            // Como a producao (agent-review.stage, camada 3): o que o dedup nao classificou fica.
            const kept = [...new Set([...(r.kept || []), ...(r.unmentioned || [])])].sort((a, b) => a - b);
            // Quem foi fundido em quem (depois do guarda): o tamanho do grupo e o sinal de consenso.
            const membros = Object.fromEntries(kept.map((k) => [k, [k]]));
            for (const d of r.dropped || []) if (membros[d.keptInto]) membros[d.keptInto].push(d.idx);
            res.prs[cid] = { antes: cands.length, kept, membros, depois: kept.length, noOp: !!r.noOp, textos: kept.map((k) => cands[k]?.suggestionContent).filter(Boolean) };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const com = Object.fromEntries(Object.entries(res.prs).filter(([, p]) => !p.erro).map(([c, p]) => [c, p.textos]));
    fs.writeFileSync(OUT.replace(/\.json$/, '.comentarios.json'), JSON.stringify(com));
    console.log(JSON.stringify({ sufixo: SUFIXO, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, antes: ok.reduce((a, p) => a + p.antes, 0), depois: ok.reduce((a, p) => a + p.depois, 0), noOp: ok.filter((p) => p.noOp).length }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
