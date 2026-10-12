#!/usr/bin/env node
/**
 * Scores a dedup run against the gold, on the PRs whose labels were
 * human-reviewed. Dedup output: { prs: { caseId: { membros: {rep: [idx...]} } } }
 * (dedup-producao.js) or { prs: { caseId: { itens: [{ membros: [idx...] }] } } }
 * (dedup-fusao.js, after the dedup reviewer). Indices are the pool positions,
 * i.e. the gold's sourceIndex.
 *
 *   node evals/dedup/gold/score-dedup.js --model=gpt-6.1-sol --run=<file> [--run=<file> ...]
 */
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const MODEL = argv.find((a) => a.startsWith('--model='))?.split('=')[1];
const RUNS = argv.filter((a) => a.startsWith('--run=')).map((a) => a.slice(6));
const goldFile = fs.readdirSync(__dirname).find((f) => f.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')).model === MODEL);
const gold = JSON.parse(fs.readFileSync(path.join(__dirname, goldFile), 'utf8'));

const reviewed = Object.entries(gold.prs).filter(([, pr]) => pr.groups.some((g) => g.humanReview) || Object.keys(pr.humanReviewUnique || {}).length);
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

for (const run of RUNS) {
    const out = JSON.parse(fs.readFileSync(run, 'utf8')).prs;
    const t = { goldGroups: 0, full: 0, exact: 0, partial: 0, missed: 0, goldPairs: 0, pairsFound: 0, predPairs: 0, wrongPairs: 0, unifiedGroups: 0, unifiedFull: 0, prs: 0, exactPrs: 0 };
    const misses = [];
    for (const [caseId, pr] of reviewed) {
        const o = out[caseId];
        if (!o || o.erro) {
            misses.push(`${caseId}: no dedup output`);
            continue;
        }
        t.prs++;
        const idOf = Object.fromEntries(pr.suggestions.map((s) => [s.sourceIndex, s.id]));
        const clusters = o.itens ? o.itens.map((i) => i.membros) : Object.values(o.membros);
        const cl = {};
        clusters.forEach((ms, n) => ms.forEach((m) => (cl[idOf[m]] = n)));
        for (const s of pr.suggestions) if (cl[s.id] === undefined) cl[s.id] = `solo:${s.id}`;
        const gOf = {};
        for (const g of pr.groups) for (const m of g.members) gOf[m] = g.groupId;
        let prExact = true;
        for (const g of pr.groups) {
            t.goldGroups++;
            if (g.needsUnifiedComment) t.unifiedGroups++;
            const cs = new Set(g.members.map((m) => cl[m]));
            if (cs.size === 1) {
                t.full++;
                if (g.needsUnifiedComment) t.unifiedFull++;
                const c = [...cs][0];
                const size = pr.suggestions.filter((s) => cl[s.id] === c).length;
                if (size === g.members.length) t.exact++;
                else prExact = false;
            } else {
                prExact = false;
                const biggest = Math.max(...[...cs].map((c) => g.members.filter((m) => cl[m] === c).length));
                if (biggest > 1) t.partial++;
                else t.missed++;
            }
        }
        const ids = pr.suggestions.map((s) => s.id);
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
            const same = gOf[ids[i]] && gOf[ids[i]] === gOf[ids[j]];
            const pred = cl[ids[i]] === cl[ids[j]];
            if (same) t.goldPairs++;
            if (pred) t.predPairs++;
            if (same && pred) t.pairsFound++;
            if (pred && !same) {
                t.wrongPairs++;
                prExact = false;
            }
        }
        if (prExact) t.exactPrs++;
    }
    console.log(`\n${MODEL} · ${path.relative(process.cwd(), run)} · ${t.prs} reviewed PRs`);
    console.log(`  gold groups fully merged:      ${t.full}/${t.goldGroups} (${pct(t.full, t.goldGroups)})`);
    console.log(`    ... and with nothing extra:  ${t.exact}/${t.goldGroups} (${pct(t.exact, t.goldGroups)})`);
    console.log(`  partly merged / not merged:    ${t.partial} / ${t.missed}`);
    console.log(`  needsUnifiedComment merged:    ${t.unifiedFull}/${t.unifiedGroups}`);
    console.log(`  duplicate pairs found (recall):${t.pairsFound}/${t.goldPairs} (${pct(t.pairsFound, t.goldPairs)})`);
    console.log(`  merged pairs correct (prec.):  ${t.predPairs - t.wrongPairs}/${t.predPairs} (${pct(t.predPairs - t.wrongPairs, t.predPairs)})`);
    console.log(`  PRs grouped exactly right:     ${t.exactPrs}/${t.prs}`);
    for (const m of misses) console.log(`  ! ${m}`);
}
process.exit(0);
