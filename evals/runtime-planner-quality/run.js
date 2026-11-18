#!/usr/bin/env node
// runtime-planner-quality: how well Kody Runtime's test planner and recipe
// author did on the kr-* test repositories, scored from what the product did
// (the Runs and setups export.js reads from the Runtime Postgres) against the
// labels in cases.json. The entry-point extractor is production's own
// extractEntryPoints, run on each case's recorded diff and content.
//
//   node evals/runtime-planner-quality/run.js --traces=<traces.json> [--since=<ISO date>]
//        [--runs=<id prefix,...>] [--regate [--repeat-rounds]] [--output=<result.json>] [--json]
//
// No model call: the planner already ran in the product. Exit: 0 measured,
// 2 not measured (no traces, or more than 5% of the cases with Runs and no
// plan). No floor yet (evals/README.md rule 9): see README "Gate".
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { registerTs } = require('../shared/eval-kit');
const { resultProblems } = require('../shared/eval-result');
const { scoreAll } = require('./score');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const QUESTION =
    'Does Kody Runtime’s planner probe what each kr-* pull request changes, at the path the app serves, predict what base answers, end in the same right verdict when the same PR runs again, and does the recipe author boot a repository within its token budget?';

function notMeasured(why) {
    console.error(`not measured: ${why}`);
    process.exit(2);
}

function main() {
    if (!args.traces || !fs.existsSync(args.traces))
        notMeasured('--traces=<file> written by export.js is required');
    let traces;
    try {
        traces = JSON.parse(fs.readFileSync(args.traces, 'utf8'));
    } catch (e) {
        notMeasured(`the traces file does not parse (${e.message})`);
    }
    if (!Array.isArray(traces?.runs))
        notMeasured('the traces file has no runs');
    const labels = require('./cases.json');
    registerTs();
    const { extractEntryPoints, routesServedBy } = require(
        path.join(ROOT, 'libs/runtime/entry-points/extract.ts'),
    );
    const runIds = args.runs ? String(args.runs).split(',') : undefined;
    // --regate: the recorded replay rounds decided again by the current gate: a round's recorded body
    // (an export from the worker) gives its fields again, then decideProbe and the intended-change step.
    const intendedChange = args.regate
        ? require(path.join(ROOT, 'libs/runtime/gate/intended-change.ts'))
              .decideIntendedChange
        : undefined;
    const { decideProbe } = args.regate
        ? require(path.join(ROOT, 'libs/runtime/gate/gate.ts'))
        : {};
    const { notJsonBodyFields } = args.regate
        ? require(path.join(ROOT, 'libs/runtime/gate/probe-fields.ts'))
        : {};
    const s = scoreAll(traces, labels, {
        extractEntryPoints,
        routesServedBy,
        intendedChange,
        decideProbe,
        notJsonBodyFields,
        repeatRounds: !!args['repeat-rounds'],
        since: args.since,
        runIds,
        ...(runIds ? { authors: [] } : {}),
    });

    const unmeasured = s.cases.filter((c) => !c.scored.length);
    const t = s.totals;
    const pct = (r) =>
        r.value === null
            ? 'n/a'
            : `${r.hits}/${r.total} (${Math.round(r.value * 100)}%)`;
    const lines = [
        `traces: ${traces.exportedAt} · runs ${traces.runs.length}${args.since ? ` · since ${args.since}` : ''}${runIds ? ` · runs ${runIds.join(',')}` : ''}${intendedChange ? ` · regated by the current gate${args['repeat-rounds'] ? ', missing rounds assumed to repeat' : ''}` : ''}`,
        `planned Runs scored: ${t.planned} (no plan or no verdict: ${s.noPlan}; no model call: ${t.noModel}); unlabelled: ${s.unlabelled.length}`,
        `right Runs (accepted verdict, and a probe on what the diff reaches): ${pct(t.right)}`,
        `  verdict accepted: ${pct(t.verdict)}`,
        `  relevant probe (cases whose diff reaches a route): ${pct(t.relevant)}`,
        `  probe precision (probes on what the diff reaches): ${pct(t.precision)}`,
        `  path under the app's prefix: ${pct(t.prefix)}`,
        `  expected status = base's status: ${pct(t.expectation)}`,
        `  route mapping (changed files that serve a route, mapped by the extractor): ${pct(t.routeMapping)}; over-mapped: ${t.overMapped.routes} routes in ${t.overMapped.files} of ${t.overMapped.of} files`,
        `  plan seconds (model plans): p50 ${t.planSeconds.p50?.toFixed(1)} · p90 ${t.planSeconds.p90?.toFixed(1)} · max ${t.planSeconds.max?.toFixed(1)} over ${t.planSeconds.runs}; tokens in ${t.planTokens.in} out ${t.planTokens.out} (p50 in ${t.planTokens.p50In})`,
        `stability (cases with 2+ planned Runs):`,
        ...t.stableCases.map(
            (c) =>
                `  ${c.id}: ${c.runs} Runs, modal verdict ${Math.round(c.modalVerdictShare * 100)}% ${JSON.stringify(c.verdicts)}, ${c.shapes} plan shape(s)`,
        ),
        ...(s.regated
            ? [
                  `regated: ${s.regated.runsMoved} Run verdict(s) and ${s.regated.probesMoved} probe verdict(s) moved; ${s.regated.intended} probe(s) intended; ${s.regated.roundsWithBody} round(s) with a recorded body, fields derived again; ${s.regated.needsRound} probe(s) would need a round the replay never played (left as recorded)${args['repeat-rounds'] ? `; ${s.regated.assumedRounds} probe(s) decided with the last recorded round repeated (assumed)` : ''}`,
              ]
            : []),
        `recipe author: ${t.author.calls} calls, ${t.author.unmeasured} not measured (model route down); booted ${pct(t.author.booted)}, submitted ${pct(t.author.submitted)}, out of token budget ${pct(t.author.budgetOut)}; p50 ${t.author.p50In} input tokens, ${t.author.p50Seconds?.toFixed(0)} s`,
    ];
    if (args.json) console.log(JSON.stringify(s, null, 2));
    else {
        console.log(lines.join('\n'));
        for (const c of s.cases) {
            console.log(
                `\n${c.id} (${c.acts ? 'acts' : 'control'}): ${c.scored.filter((x) => x.right).length}/${c.scored.length} right of ${c.runs} Runs`,
            );
            for (const r of c.scored)
                console.log(
                    `  ${r.runId} ${r.at.slice(0, 16)} ${r.recordedVerdict ? `${r.recordedVerdict} → ` : ''}${r.verdict}${r.intendedShown ? ' (intended change)' : ''} ${r.right ? 'right' : 'WRONG'}${r.relevant === false ? ' no-relevant-probe' : ''}${r.prefix && r.prefix.hits < r.prefix.total ? ` prefix ${r.prefix.hits}/${r.prefix.total}` : ''}${r.expectationMisses.length ? ` expect-miss ${r.expectationMisses.length}` : ''} ${r.seconds === null ? '' : `${r.seconds.toFixed(0)}s`} :: ${r.shape}`,
                );
            for (const f of c.extractor?.files || [])
                console.log(
                    `  extractor ${f.file}: ${f.mapped === null ? 'serves nothing' : f.mapped ? 'mapped' : 'NOT mapped'}; ${f.routes.length} route(s), ${f.overMapped} the diff does not reach`,
                );
        }
        if (s.unlabelled.length)
            console.log(
                `\nunlabelled planned Runs: ${s.unlabelled.join(', ')}`,
            );
    }

    const result = {
        eval: 'evals/runtime-planner-quality',
        question: QUESTION,
        model: 'product (the org runtime slot the Runs used)',
        runs: 1,
        metric: {
            name: 'right Runs',
            value: t.right.value ?? 0,
            floor: null,
            baseline: null,
        },
        metrics: {
            verdict: t.verdict,
            relevant: t.relevant,
            precision: t.precision,
            prefix: t.prefix,
            expectation: t.expectation,
            routeMapping: t.routeMapping,
            overMapped: t.overMapped,
            planSeconds: t.planSeconds,
            planTokens: t.planTokens,
            stability: t.stableCases,
            author: t.author,
        },
        cases: [
            ...s.cases.map((c) => ({
                id: c.id,
                checks: c.checks,
                hits: c.scored.filter((x) => x.right).length,
                total: c.scored.length,
                detail: c.scored.map((x) => ({
                    what: `${x.runId} ${x.verdict}: ${x.shape}`.slice(0, 160),
                    ok: x.right,
                })),
                ...(c.scored.length ? {} : { unmeasured: true }),
            })),
            ...[...new Set(s.authors.map((a) => a.repo))].map((repo) => {
                const mine = s.authors.filter((a) => a.repo === repo);
                return {
                    id: `author-${repo}`,
                    checks: `The recipe author's recipe for ${repo} boots, within its token budget.`,
                    hits: mine.filter((a) => a.booted).length,
                    total: mine.length,
                    detail: mine.map((a) => ({
                        what: `${a.at.slice(0, 16)} ${a.step}: ${a.booted ? 'booted' : a.reason || a.boot}`.slice(
                            0,
                            160,
                        ),
                        ok: a.booted,
                    })),
                };
            }),
        ],
        // The planner ran in the product; this eval makes no model call (evals/README.md rule 13).
        tokens: {
            in: 0,
            cacheRead: 0,
            cacheWrite: 0,
            out: 0,
            calls: 0,
            ms: 0,
            callMs: [],
        },
        infra: { errored: s.noPlan, total: s.noPlan + t.planned },
    };
    const problems = resultProblems(result);
    if (problems.length)
        notMeasured(`the result is malformed: ${problems.join('; ')}`);
    if (args.output)
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    const withRuns = s.cases.length;
    if (!withRuns) notMeasured('no labelled case has a Run in the traces');
    if (unmeasured.length / withRuns > 0.05)
        notMeasured(
            `${unmeasured.length} of ${withRuns} cases have Runs but no plan: ${unmeasured.map((c) => c.id).join(', ')}`,
        );
    process.exit(0);
}

main();
