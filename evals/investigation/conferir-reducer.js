#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Confere que o reducer de PRODUCAO (libs/.../finding-reducer.ts) reproduz,
 * sobre os mesmos dados offline, o numero que a planilha em Python publica.
 * Se os dois divergirem, o que esta em producao nao e o que foi medido.
 *
 *   node conferir-reducer.js [cota] [limiar]
 */
const fs = require('fs');
const path = require('path');
const M = require('../../libs/code-review/infrastructure/agents/engine/finding-reducer.ts');

const AQ = __dirname;
const res = (f) => JSON.parse(fs.readFileSync(path.join(AQ, 'results', f), 'utf8'));
const sel = res(process.env.REP_SELETOR || 'fix-seletor.json').saida;
const ver = res(process.env.REP_VERACIDADE || 'fix-score2.json').saida;
const mat = res(process.env.REP_MATRIZ || 'matriz-fix.json');
const POOL = path.join(AQ, 'pools', process.env.REP_POOL || 'fix');
const CORE = new Set(['bug','security','concurrency','data','api','perf','test_gap','doc_defect']);

const pool = {};
for (const f of fs.readdirSync(POOL).filter((x) => x.endsWith('.raw.txt'))) {
    const j = JSON.parse(fs.readFileSync(path.join(POOL, f), 'utf8'));
    const cands = j.trace?.preFilterCandidates || [];
    pool[j.caseId] = {
        cands,
        keep: cands.map((c, i) => [c, i]).filter(([c]) => M.passesContract(c)).map(([, i]) => i),
    };
}

function medir(QUOTA, LIM) {
    let tp = 0, fp = 0, tot = 0, n = 0, prs = 0;
    for (const [cid, v] of Object.entries(sel)) {
        if (!mat[cid] || !pool[cid]) continue;
        const { cands, keep } = pool[cid];
        if (keep.length !== v.candidatos) continue;
        const conf = mat[cid].conf;
        const gs = mat[cid].goldens;
        const coreG = gs.map((g, i) => [g, i]).filter(([g]) => CORE.has(g.category)).map(([, i]) => i);
        const dono = {};
        gs.forEach((_, gi) => {
            let best = 0, who = -1;
            keep.forEach((ci, pos) => {
                const c = conf[gi]?.[ci] || 0;
                if (c > best) { best = c; who = pos; }
            });
            if (who >= 0) dono[gi] = who;
        });
        const grupos = v.grupos.map((g) => {
            const idx = g.indices.filter((i) => i < keep.length);
            if (!idx.length) return null;
            const rep = idx.includes(g.representante) ? g.representante : idx[0];
            const f = M.groupFeatures(idx.map((i) => cands[keep[i]]), g.nota, ver[cid]?.[String(keep[rep])]);
            const cobre = Object.entries(dono).filter(([, pos]) => idx.includes(pos)).map(([gi]) => Number(gi));
            return { p: M.reducerProbability(f), cobre, core: cobre.filter((gi) => coreG.includes(gi)) };
        }).filter(Boolean);
        prs++; tot += coreG.length;
        const cob = new Set();
        for (const g of [...grupos].sort((a, b) => b.p - a.p).slice(0, QUOTA).filter((g) => g.p >= LIM)) {
            n++;
            if (g.core.length) g.core.forEach((x) => cob.add(x));
            else if (!g.cobre.length) fp++;
        }
        tp += cob.size;
    }
    const r = tp / tot, p = tp / (tp + fp);
    return { prs, r, p, f1: 2*r*p/(r+p), f2: 5*r*p/(4*p+r), cpr: n/prs };
}

const args = process.argv.slice(2);
const pares = args.length ? [[Number(args[0]), Number(args[1] ?? M.REDUCER_THRESHOLD)]]
    : [[5,0],[6,0.22],[7,0],[7,0.18],[M.REDUCER_QUOTA, M.REDUCER_THRESHOLD],[7,0.30],[8,0.22]];
console.log(`${'cota'.padStart(5)} ${'limiar'.padStart(7)} ${'recall'.padStart(8)} ${'precis'.padStart(8)} ${'F1'.padStart(6)} ${'F2'.padStart(6)} ${'c/PR'.padStart(6)}`);
for (const [K, L] of pares) {
    const m = medir(K, L);
    const pad = K === M.REDUCER_QUOTA && L === M.REDUCER_THRESHOLD ? '  <- default de producao' : '';
    console.log(`${String(K).padStart(5)} ${L.toFixed(2).padStart(7)} ${(m.r*100).toFixed(1).padStart(7)}% ${(m.p*100).toFixed(1).padStart(7)}% ${m.f1.toFixed(3).padStart(6)} ${m.f2.toFixed(3).padStart(6)} ${m.cpr.toFixed(1).padStart(6)}${pad}`);
}
