#!/usr/bin/env node
// Confirms a nightly that went below its floor before anyone is alerted.
//
// One 30-PR run can land under the floor by noise alone. When the first run
// fails the gate, the nightly measures the same commit again and this script
// decides on the MEAN of the two runs: false alarms nearly vanish, and a real
// drop still shows. It writes one combined result in run-recall's shape, so
// the report and the investigation read it like any other night.
//
//   node evals/investigation/confirm-gate.js <first.json> <second.json> --out=<combined.json> [--set=light]
//
// Exit: 0 the drop did not hold (oscillation) / 1 confirmed below the floor /
// 2 the confirmation could not measure (infra), so nothing is confirmed.
const fs = require('fs');
const { evaluateGate, avg } = require('./gate');

const MEANS = ['recall', 'precision', 'f1', 'fairRecall', 'hitRate', 'totalCalls', 'tpFindings', 'fpFindings'];

// The summary field each per-case metric feeds (run-recall.js builds the same
// means from the same rows).
const SUMMARY_OF = { recall: 'recall_mean', precision: 'precision_mean', f1: 'f1_mean', fairRecall: 'fair_recall_mean', hitRate: 'fidelity_mean' };

function paired(row) {
    return Boolean(row && row.pairedInBothRuns);
}

function combineRow(a, b) {
    if (!b || b.status === 'infra' || !b.metadata) return a;
    if (!a || a.status === 'infra' || !a.metadata) return b;
    const metadata = { ...a.metadata };
    for (const key of MEANS) metadata[key] = avg([a.metadata[key], b.metadata[key]]);
    // A known bug counts as found if either run found it, so "lost" in the
    // message means missed by both runs, not by one unlucky sample.
    const foundInB = new Set((b.metadata.goldenResults || []).filter((g) => g.found).map((g) => g.golden));
    if (Array.isArray(a.metadata.goldenResults)) {
        metadata.goldenResults = a.metadata.goldenResults.map((g) => ({ ...g, found: g.found || foundInB.has(g.golden) }));
    }
    // Measured by both runs: only these carry the combined mean, so a PR one
    // run skipped can't tilt the decision by being in one side's average only.
    return { ...a, metadata, tokenUsage: undefined, pairedInBothRuns: true };
}

function combineRuns(first, second, gateFor) {
    const byCase = new Map((second.rows || []).map((row) => [row.caseId, row]));
    const rows = (first.rows || []).map((row) => combineRow(row, byCase.get(row.caseId)));
    const infraFailures = rows.filter((row) => row.status === 'infra').length;
    // Means over the PRs BOTH runs measured, from their per-case values —
    // never the average of a 30-PR mean and a 28-PR one, which would move the
    // gate by which PRs the second run happened to skip. Metrics run-recall
    // writes but no row carries are averaged from the summaries, so no
    // consumer sees a field vanish.
    const pairedRows = rows.filter(paired);
    const metricKeys = new Set([...Object.keys(first.metrics || {}), ...Object.keys(second.metrics || {})]);
    const fromRows = Object.fromEntries(
        Object.entries(SUMMARY_OF)
            .filter(([, summaryKey]) => metricKeys.has(summaryKey))
            .map(([rowKey, summaryKey]) => [summaryKey, avg(pairedRows.map((row) => row.metadata?.[rowKey]))]),
    );
    const metrics = Object.fromEntries(
        // Falling back to the run means keeps a metric the rows don't carry
        // (an older artifact, a field added later) instead of dropping it.
        [...metricKeys].map((key) => [key, fromRows[key] ?? avg([first.metrics?.[key], second.metrics?.[key]])]),
    );
    const combined = {
        ...first,
        finishedAt: second.finishedAt,
        tokens: {
            prompt: (first.tokens?.prompt || 0) + (second.tokens?.prompt || 0),
            completion: (first.tokens?.completion || 0) + (second.tokens?.completion || 0),
        },
        cases: rows.length,
        passed: rows.filter((row) => row.status === 'pass').length,
        failed: rows.filter((row) => row.status === 'fail').length,
        infraFailures,
        metrics,
        rows,
    };
    combined.gate = {
        ...gateFor(combined, rows),
        confirmation: {
            runs: [first.metrics?.recall_mean ?? null, second.metrics?.recall_mean ?? null],
            firstGate: first.gate?.status || null,
            secondInfra: second.infraFailures || 0,
            pairedCases: pairedRows.length,
        },
    };
    return combined;
}

function main() {
    const [firstFile, secondFile] = process.argv.slice(2);
    const out = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!firstFile || !secondFile || !out) {
        console.error('usage: node evals/investigation/confirm-gate.js <first.json> <second.json> --out=<combined.json>');
        return 2;
    }
    const first = read(firstFile);
    let second;
    try {
        second = read(secondFile);
    } catch {
        second = null;
    }
    // The confirmation measures under the same rule as the first run: a couple
    // of unmeasured PRs (within the budget run-recall recorded) still confirm.
    const secondUnmeasured = second?.infraFailures || 0;
    if (!second || second.error || secondUnmeasured > (second.infraBudget || 0)) {
        // Nothing confirmed: report the first run, flagged as unconfirmed infra.
        const reason = second?.error || (second ? `${second.infraFailures} PRs not measured in the confirmation run` : 'the confirmation run wrote no result');
        fs.writeFileSync(out, JSON.stringify({ ...first, confirmationError: reason }, null, 2));
        console.error(`confirmation did not measure: ${reason}`);
        return 2;
    }
    const setName = (process.argv.find((a) => a.startsWith('--set=')) || '--set=light').slice(6);
    const combined = combineRuns(first, second, (summary, rows) => evaluateGate(summary, rows, first.model, setName));
    fs.writeFileSync(out, JSON.stringify(combined, null, 2));
    const [r1, r2] = combined.gate.confirmation.runs;
    console.log(`confirmation: runs ${Math.round(r1 * 100)}% and ${Math.round(r2 * 100)}% → mean ${Math.round(combined.metrics.recall_mean * 100)}% · gate ${combined.gate.status}`);
    return { pass: 0, fail: 1 }[combined.gate.status] ?? 2;
}

module.exports = { combineRuns };

if (require.main === module) process.exit(main());
