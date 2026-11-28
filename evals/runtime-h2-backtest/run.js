#!/usr/bin/env node
// Scores the H2 backtest over the Runs the product
// made on the replayed kr-* pull requests. The traces come from
// evals/runtime-planner-quality/export.js (same export: the Run's report and plan),
// the cases and the two labelers' labels from cases.json.
//
//   node evals/runtime-h2-backtest/run.js --traces=traces.json [--cases=<file>] [--json] [--output=<file>]
//
// Exit 0 pass, 1 fail, 2 not measured: fewer than 20 reproduced cases with a Run,
// a broken control guard (not interpretable), or unusable input (evals/README.md rule 10).
const fs = require('fs');
const path = require('path');
const { registerTs } = require('../shared/eval-kit');
const { scoreAll } = require('./score');

const ROOT = path.join(__dirname, '..', '..');
const QUESTION =
    'Does Kody Runtime’s first Run on a pull request that later needed a revert or a hotfix publish that bug, where two Kody reviews of the same pull request did not point at it, without false regressions on safe controls?';
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);

function notMeasured(why) {
    console.error(`not measured: ${why}`);
    process.exit(2);
}

function main() {
    if (!args.traces || !fs.existsSync(args.traces)) notMeasured('--traces=<file> written by evals/runtime-planner-quality/export.js is required');
    let traces;
    try {
        traces = JSON.parse(fs.readFileSync(args.traces, 'utf8'));
    } catch (e) {
        notMeasured(`the traces file does not parse (${e.message})`);
    }
    if (!Array.isArray(traces?.runs)) notMeasured('the traces file has no runs');
    const cases = JSON.parse(fs.readFileSync(args.cases || path.join(__dirname, 'cases.json'), 'utf8'));
    registerTs();
    const { requestMatchesEntryPoint } = require(path.join(ROOT, 'libs/runtime/entry-points/coverage.ts'));
    const s = scoreAll(cases, traces, { matches: requestMatchesEntryPoint });
    const result = {
        eval: 'runtime-h2-backtest',
        question: QUESTION,
        runs: 1,
        metric: { name: 'h2_recall_on_reproduced_bugs', value: s.recall.of ? s.recall.found / s.recall.of : null, floor: null, baseline: null },
        cases: s.cases.map((c) => ({ id: c.id, checks: c.kind === 'case' ? 'the first Run publishes the reproduced bug on its oracle route' : 'a safe change gets no confirmed false regression', hits: c.kind === 'case' ? (c.found ? 1 : 0) : c.falseRegressions ? 0 : 1, total: c.measured ? 1 : 0 })),
        tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, calls: 0, ms: 0, callMs: [] },
        infra: { errored: s.cases.filter((c) => !c.measured).length, total: s.cases.length },
        h2: { verdict: s.verdict, funnel: s.funnel, recall: s.recall, agreement: s.agreement },
    };
    if (args.output) fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
    if (args.json) console.log(JSON.stringify(s, null, 2));
    else {
        const f = s.funnel;
        const [lo, hi] = s.recall.wilson95;
        console.log(
            [
                `H2: ${s.verdict}`,
                `funnel: ${f.pairs} cases → ${f.reproduced} reproduced → ${f.measured} with a Run → ${f.found} found → ${f.reviewBlindFound} review-blind`,
                `recall: ${s.recall.found}/${s.recall.of}${lo === null ? '' : ` (Wilson 95% ${Math.round(lo * 100)}–${Math.round(hi * 100)}%)`}`,
                `controls: ${f.controlsMeasured}/${f.controls} measured, ${f.controlsWithFalseRegression} with a confirmed false regression (guard: at most 2)`,
                `agreement: review κ ${s.agreement.review.kappa?.toFixed(2) ?? 'n/a'} over ${s.agreement.review.n}; findings κ ${s.agreement.findings.kappa?.toFixed(2) ?? 'n/a'} over ${s.agreement.findings.n} (rewrite the rule below 0.6)`,
                ...s.cases.map((c) => `  ${c.id} ${c.kind} ${c.measured ? (c.kind === 'case' ? `${c.found ? 'FOUND' : 'missed'} · on target ${c.onTarget} · review-blind ${c.reviewBlind}` : `false regressions ${c.falseRegressions}`) : `not measured (${c.why})`}`),
            ].join('\n'),
        );
    }
    process.exit(s.verdict === 'pass' ? 0 : s.verdict === 'fail' ? 1 : 2);
}

main();
