#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Pontua um conjunto mantido (indices no pool pre-reducer) contra os goldens,
 * com a mesma regra da metrica: tp = goldens cobertos, fp = mantido que nao
 * cobriu nenhum.
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const KEEP = arg('keep');
const PAR = Number(arg('par', '8'));
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

(async () => {
    const keep = JSON.parse(fs.readFileSync(KEEP, 'utf8')).keep;
    const goldens = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId) goldens[v.caseId] = J(v.goldenComments);
        } catch {}
    }
    const key = loadJudgeKey();
    let TP = 0, FP = 0, GOLD = 0, KEPT = 0;
    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        const gs = goldens[cid] || [];
        if (!gs.length) continue;
        GOLD += gs.length;
        const cands = j.trace?.preFilterCandidates || [];
        const idx = keep[cid] || [];
        const mantidos = idx.map((i) => cands[i]).filter(Boolean);
        KEPT += mantidos.length;
        const textos = mantidos.map((c) =>
            [c.oneSentenceSummary, c.suggestionContent].filter(Boolean).join('\n').slice(0, 1800));
        const venceu = new Array(mantidos.length).fill(false);
        let cobertos = 0;
        for (const g of gs) {
            const confs = [];
            for (let b = 0; b < textos.length; b += PAR) {
                const lote = await Promise.all(textos.slice(b, b + PAR).map(async (t) => {
                    try {
                        const v = await matchCommentDetailed(key, g.comment, t);
                        return v?.match ? (v.confidence ?? 0) : 0;
                    } catch { return 0; }
                }));
                confs.push(...lote);
            }
            let best = 0, achou = false;
            for (let i = 0; i < confs.length; i++) {
                if (confs[i] > best) { best = confs[i]; achou = true; venceu[i] = true; }
            }
            if (achou) cobertos++;
        }
        TP += cobertos;
        FP += venceu.filter((v) => !v).length;
        console.log(`  ${cid.slice(0, 46).padEnd(48)} ${mantidos.length} mantidos · ${cobertos}/${gs.length} goldens`);
    }
    const r = TP / GOLD, p = TP + FP ? TP / (TP + FP) : 0;
    console.log(`\n${KEPT} mantidos · tp ${TP} · fp ${FP} · de ${GOLD} goldens`);
    console.log(`recall ${(100 * r).toFixed(1)}% · precision ${(100 * p).toFixed(1)}% · F1 ${(2 * r * p / (r + p)).toFixed(3)}`);
})().catch((e) => { console.error(e); process.exit(1); });
