#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: segunda passada do dedup de producao, so nas sugestoes que a primeira
 * deixou sozinhas (grupo de um membro). Os grupos ja formados ficam como estao.
 * Mesmo prompt e guarda em camadas (--guard=tiered), no modelo do cenario.
 *
 *   RECALL_MODEL=<id> node dedup-segunda.js --dedup=<saida da 1a> --poolsv=<pool>-heavysv --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { runDedup } = require('../dedup/dedup-runner');
const { buildModel } = require('./eval-model');
const { TIER0 } = require('../shared/tier0-models');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const DEDUP = arg('dedup'), POOLSV = arg('poolsv'), OUT = arg('out'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;
const assinatura = ['codex_subscription', 'claude_agent_sdk'].includes(TIER0[MODELO]?.provider);
(async () => {
    const prebuilt = assinatura ? buildModel(MODELO) : undefined;
    const R1 = JSON.parse(fs.readFileSync(DEDUP, 'utf8')).prs;
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const cands = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', POOLSV, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const p = R1[cid];
            const sozinhos = p.kept.filter((k) => (p.membros[k] || [k]).length === 1);
            const grupos = p.kept.filter((k) => (p.membros[k] || [k]).length > 1);
            const membros = Object.fromEntries(grupos.map((k) => [k, p.membros[k]]));
            let novas = 0, guarda = {};
            if (sozinhos.length > 1) {
                const op = { guard: 'tiered', prebuiltModel: prebuilt };
                const r = await runDedup(sozinhos.map((k) => cands[k]), MODELO, op);
                guarda = op.guardReasons || {};
                const kept2 = [...new Set([...(r.kept || []), ...(r.unmentioned || [])])];
                for (const j of kept2) membros[sozinhos[j]] = [sozinhos[j]];
                for (const d of r.dropped || []) { const rep = sozinhos[d.keptInto]; if (membros[rep]) { membros[rep].push(sozinhos[d.idx]); novas++; } }
            } else for (const k of sozinhos) membros[k] = [k];
            const kept = Object.keys(membros).map(Number).sort((a, b) => a - b);
            res.prs[cid] = { antes: p.kept.length, sozinhos: sozinhos.length, novasFusoes: novas, guarda, kept, membros, depois: kept.length };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const g = {}; for (const p of ok) for (const [k, v] of Object.entries(p.guarda || {})) g[k] = (g[k] || 0) + v;
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, antes: ok.reduce((a, p) => a + p.antes, 0), sozinhos: ok.reduce((a, p) => a + p.sozinhos, 0), novasFusoes: ok.reduce((a, p) => a + p.novasFusoes, 0), depois: ok.reduce((a, p) => a + p.depois, 0), guarda: g }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
