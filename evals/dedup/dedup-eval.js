// Core dedup-eval logic: golden-anchored ground truth (no new labeling, judged
// by the configured JUDGE_MODEL — pinned to claude-haiku-4-5 by run.js so it
// stays a DIFFERENT model than the gpt-5.4-mini dedup, keeping it non-circular).
//
// For one PR:
//   1. matchFindingsToGoldens — judge-label each finding with the golden it hits
//      (or -1 = noise). Reuses recall-judge's Sonnet matcher.
//   2. (caller runs the REAL dedup → {kept[], dropped[{idx,keptInto}]})
//   3. computeMetrics — does dedup drop a finding that was the ONLY cover for a
//      golden? That golden is LOST (over-merge = recall harm). Plus under-merge
//      (residual dups left among kept) and good noise/dup merges.
const { matchComment } = require('../investigation/recall-judge');

// Same finding→text representation the recall eval judges on (recall-assertion.js).
function findingText(f) {
    return [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile]
        .filter(Boolean)
        .map((t) => String(t).trim())
        .join(' — ')
        .slice(0, 1200);
}

/**
 * Label each finding with the index of the golden it matches (first match wins),
 * or -1 if it matches none. F×G judge calls worst case; short-circuits on match.
 */
async function matchFindingsToGoldens(findings, goldens, apiKey) {
    const labels = new Array(findings.length).fill(-1);
    for (let fi = 0; fi < findings.length; fi++) {
        const cand = findingText(findings[fi]);
        for (let gi = 0; gi < goldens.length; gi++) {
            if (await matchComment(apiKey, goldens[gi], cand)) {
                labels[fi] = gi;
                break;
            }
        }
    }
    return labels;
}

/** Set of golden indices (>=0) covered by the given finding indices. */
function goldensCovered(findingIdxs, goldenLabels) {
    const s = new Set();
    for (const i of findingIdxs) if (goldenLabels[i] >= 0) s.add(goldenLabels[i]);
    return s;
}

/**
 * @param {number} totalFindings
 * @param {number[]} goldenLabels   golden idx per finding (or -1)
 * @param {{kept:number[], dropped:Array<{idx,keptInto}>}} dedup
 */
function computeMetrics(totalFindings, goldenLabels, dedup) {
    const allIdx = Array.from({ length: totalFindings }, (_, i) => i);
    const keptIdx = dedup.kept;
    const droppedIdx = dedup.dropped.map((d) => d.idx);

    const before = goldensCovered(allIdx, goldenLabels);
    const after = goldensCovered(keptIdx, goldenLabels);
    const lostGoldens = [...before].filter((g) => !after.has(g)); // OVER-MERGE harm

    // classify each dropped finding
    let noiseMerged = 0; // dropped, hit no golden → good (less spam)
    let dupMergedOk = 0; // dropped, its golden still covered by a kept finding → correct merge
    let badMerged = 0; // dropped, its golden NOT covered anymore → caused a loss
    for (const idx of droppedIdx) {
        const g = goldenLabels[idx];
        if (g < 0) noiseMerged++;
        else if (after.has(g)) dupMergedOk++;
        else badMerged++;
    }

    // under-merge: a golden covered by >=2 KEPT findings (dedup left residual dups)
    let underMergeDups = 0;
    const keptByGolden = {};
    for (const i of keptIdx) if (goldenLabels[i] >= 0) {
        keptByGolden[goldenLabels[i]] = (keptByGolden[goldenLabels[i]] || 0) + 1;
    }
    for (const g of Object.keys(keptByGolden)) underMergeDups += Math.max(0, keptByGolden[g] - 1);

    return {
        findings: totalFindings,
        kept: keptIdx.length,
        dropped: droppedIdx.length,
        recallBefore: before.size,
        recallAfter: after.size,
        goldensLost: lostGoldens.length, // <-- headline harm
        noiseMerged,
        dupMergedOk,
        badMerged,
        underMergeDups,
    };
}

module.exports = { findingText, matchFindingsToGoldens, computeMetrics, goldensCovered };
