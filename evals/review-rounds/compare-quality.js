// Compare the delivery contracts of #2597, with independent denominators.
// Usage: node evals/review-rounds/compare-quality.js base.json pr.json
const fs = require('node:fs');
const { deepStrictEqual } = require('node:assert');
const { cases } = require('./cases');
const { selectCases } = require('./case-selection');
const targets = require('./targets.json');

function compare(base, pr) {
    const expected = selectCases(cases, targets.sets['review-quality-2597'].join(','));
    const ids = expected.map((c) => c.id).sort();
    for (const field of ['model', 'judge', 'judgeReasoningEffort', 'byokReasoning', 'reps', 'casesSourceDigest']) {
        deepStrictEqual(base[field], pr[field], `different ${field}`);
    }
    for (const result of [base, pr]) {
        if (!result.casesSourceDigest) throw new Error('missing case source digest');
        if (result.deliveryScope !== 'all-agents') throw new Error('whole-review comparison requires scoring every agent');
        if (!result.complete || result.infra.errored || result.reps < 1) {
            throw new Error('comparison requires complete, measured runs on both sides');
        }
        deepStrictEqual([...result.selectedCases].sort(), ids, 'unexpected case selection');
        deepStrictEqual([...new Set(result.rows.map((r) => r.case))].sort(), ids);
        for (const spec of expected) {
            const rows = result.rows.filter((r) => r.case === spec.id);
            deepStrictEqual(rows.length, result.reps);
            deepStrictEqual(new Set(rows.map((r) => r.rep)).size, result.reps);
            for (const row of rows) {
                const labels = (claims) => claims.map((c) => [c.id, c.truth, c.expect]);
                deepStrictEqual(labels(row.claims), labels(spec.claims));
                for (const claim of row.claims) {
                    if (typeof claim.pass !== 'boolean') throw new Error(`Unscored ${spec.id}`);
                }
            }
        }
    }
    const dimensions = [
        ['Original incidents: false claim withheld', /^H\d+-control$/],
        ['Original incidents: real problem delivered', /^H\d+-violation$/],
        ['Transfer: false claim withheld', /^G\d+-control$/],
        ['Transfer: real problem delivered', /^G\d+-violation$/],
        ['History: repeat suppressed', /^B\d+-repeat$/],
        ['History: neighboring issue delivered', /^B\d+-new-site$/],
        ['No history: same issue delivered', /^B\d+-no-history$/],
        ['Consequence delivered and linked', /^R(2|8)-/],
        ['Unrelated bug delivered', /^R12-/],
        ['Moved repeat suppressed', /^R13-/],
    ];
    for (const id of ids) {
        deepStrictEqual(dimensions.filter(([, pattern]) => pattern.test(id)).length, 1, id);
    }
    const score = (run, pattern) => {
        const claims = run.rows.filter((r) => pattern.test(r.case)).flatMap((r) => r.claims);
        return `${claims.filter((c) => c.pass).length}/${claims.length}`;
    };
    console.log('| Correct decisions | Base | PR |\n| --- | ---: | ---: |');
    for (const [label, pattern] of dimensions) {
        console.log(`| ${label} | ${score(base, pattern)} | ${score(pr, pattern)} |`);
    }
    for (const [name, run] of [['Base', base], ['PR', pr]]) {
        const times = run.rows.map((r) => r.reviewMs);
        let timing = 'Review-only latency unavailable in this historical run.';
        if (times.every(Number.isFinite)) {
            times.sort((a, b) => a - b);
            const mid = Math.floor(times.length / 2);
            const median = (times[mid] + times[Math.floor((times.length - 1) / 2)]) / 2;
            const p95 = times[Math.ceil(.95 * times.length) - 1];
            timing = `Median ${(median / 1000).toFixed(1)} s, p95 ${(p95 / 1000).toFixed(1)} s per review.`;
        }
        console.log(`\n${name} ${run.engine.commit}: ${run.tokens.calls} calls; ${run.tokens.in} input / ${run.tokens.out} output tokens. ${timing}`);
    }
}

try {
    const paths = process.argv.slice(2);
    if (paths.length !== 2) throw new Error('supply base.json and pr.json');
    compare(...paths.map((path) => JSON.parse(fs.readFileSync(path, 'utf8'))));
} catch (error) {
    console.error(error.message);
    process.exitCode = 2;
}
