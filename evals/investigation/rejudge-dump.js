#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Scores review outputs already saved in a RECALL_DUMP, without re-running the
 * review.
 *
 * A judge failure (credit exhaustion, HTTP 400) costs the whole case in
 * run-recall: the review itself succeeded and its findings were written to the
 * dump, but the row is marked INFRA and drops out of the metrics — numerator
 * AND denominator — which silently inflates recall on the cases that remain.
 * Re-running the review to recover the score wastes the expensive half of the
 * work. This re-judges the saved output instead.
 *
 * Usage:
 *   node evals/investigation/rejudge-dump.js --dump=<dir> --cases=a,b,c
 */
const fs = require('fs');
const path = require('path');
const { matchCommentDetailed, loadJudgeKey } = require('./recall-judge');

const DATASETS = path.join(__dirname, 'datasets');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const DUMP = arg('dump');
const ONLY = (arg('cases', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!DUMP) { console.error('need --dump'); process.exit(1); }

function goldensFor(caseId) {
    for (const f of fs.readdirSync(DATASETS)) {
        if (!f.endsWith('.json')) continue;
        let v;
        try { v = JSON.parse(fs.readFileSync(path.join(DATASETS, f), 'utf8'))[0].vars; } catch { continue; }
        if (v.caseId !== caseId) continue;
        const g = typeof v.goldenComments === 'string' ? JSON.parse(v.goldenComments) : v.goldenComments || [];
        return g.map((x) => x.comment || String(x));
    }
    return [];
}

/** Same flattening recall-assertion.js feeds the judge. */
const findingText = (f) =>
    !f || typeof f !== 'object'
        ? String(f || '')
        : [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile].filter(Boolean).join(' — ');

(async () => {
    const apiKey = await loadJudgeKey();
    const out = [];
    for (const file of fs.readdirSync(DUMP)) {
        if (!file.endsWith('.raw.txt')) continue;
        const caseId = file.replace('.raw.txt', '');
        if (ONLY.length && !ONLY.includes(caseId)) continue;
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(DUMP, file), 'utf8')); } catch { continue; }
        const findings = d.findings || [];
        const goldens = goldensFor(caseId);

        // Martian parity: tp counts GOLDENS matched, best-confidence wins, no floor.
        const gm = new Array(goldens.length).fill(false);
        const best = new Array(goldens.length).fill(0);
        const cm = new Array(findings.length).fill(false);
        for (let gi = 0; gi < goldens.length; gi++) {
            for (let fi = 0; fi < findings.length; fi++) {
                const { match, confidence } = await matchCommentDetailed(apiKey, goldens[gi], findingText(findings[fi]));
                if (match && confidence > best[gi]) { best[gi] = confidence; gm[gi] = true; cm[fi] = true; }
            }
        }
        const tp = gm.filter(Boolean).length;
        const row = { caseId, status: 'pass', metadata: { tp, fp: cm.filter((m) => !m).length, fn: goldens.length - tp, goldens: goldens.length, findings: findings.length } };
        out.push(row);
        console.log(`${caseId.slice(0, 52).padEnd(54)} tp ${tp} fp ${row.metadata.fp} fn ${row.metadata.fn} (${findings.length} findings)`);
    }
    const dest = path.join(__dirname, 'results', `rejudge-${path.basename(DUMP)}.json`);
    fs.writeFileSync(dest, JSON.stringify({ rows: out, cases: out.length, passed: out.length, infraFailures: 0 }, null, 2));
    console.log(`\n-> ${dest}`);
})();
