// How each eval runs on a real model: the nightly's shared job
// (code-review-evals-nightly.yml, `measure-evals`) and the weekly run
// (evals/weekly.js). Adding an entry is how an eval gets measured. Each one:
//   - writes the shared result with --output (evals/shared/eval-result.js),
//     its metric's floor read from its own targets file for the model and set;
//   - exits 1 below that floor with --gate, 2 when it did not measure;
//   - measures one stage of evals/stages.js, whose eval's `nightly` is 'shared';
//   - has a wiring smoke step of the same id, whose trace lists its files.
// A run below the floor is measured again and both are pooled before anyone is
// alerted (evals/shared/nightly-verdict.js), so every entry alerts the same way.
//
// When it runs (evals/README.md):
//   nightly  one model (DeepSeek), the controlled set, when one of its files changed
//   weekly   every tier-0 model on the controlled set (the full sets: on demand)
//
//   id     — the eval, and its wiring smoke step
//   stage  — the evals/stages.js stage it measures
//   run    — the command, without --model, --output and --gate
//   sets   — what selects each set: `controlled` (nightly and weekly), `full`
//            (on demand), null when the controlled set is all there is
//   files  — what changes its verdict without being loaded by the one-case run
const NIGHTLY_EVALS = [
    {
        id: 'reply-addressing',
        stage: 'reply-addressing',
        run: ['evals/reply-addressing/run.js', '--repeats=1'],
        sets: { controlled: ['--dataset=cases'], full: ['--dataset=repo-cases'] },
        files: ['evals/reply-addressing/targets.json'],
    },
    {
        id: 'review-rounds',
        stage: 'review-rounds',
        // The BYOK route with reasoning off, where the reposts were measured
        // (#2097), judged by the model the floor was calibrated with.
        run: ['evals/review-rounds/run.js', '--reps=2', '--byok-reasoning=none', '--judge=gemini-3-flash-preview', '--concurrency=6'],
        sets: { controlled: ['--set=nightly'], full: null },
        files: ['evals/review-rounds/targets.json', 'evals/review-rounds/cases.js', 'evals/review-rounds/prod-shapes/build.js'],
    },
    {
        id: 'format',
        stage: 'format',
        run: ['evals/format/run.js'],
        sets: { controlled: [], full: null },
        files: ['evals/format/targets.json'],
    },
    {
        id: 'conversation',
        stage: 'conversation',
        run: ['evals/conversation/run.js'],
        sets: { controlled: [], full: null },
        files: ['evals/conversation/targets.json'],
    },
    // Offers are reported beside the number, not gated (evals/thread-actions).
    ...['rule', 'memory'].map((kind) => ({
        id: `thread-${kind}`,
        stage: `thread-${kind}`,
        run: ['evals/thread-actions/run.js', `--kind=${kind}`],
        sets: { controlled: [], full: null },
        files: ['evals/thread-actions/targets.json'],
    })),
    // The stages after the finder, on a production review's frozen findings (evals/funnel).
    ...['dedup', 'severity', 'verify'].map((stage) => ({
        id: `funnel-${stage}`,
        stage,
        run: [`evals/funnel/${stage}/run.js`],
        sets: { controlled: ['--set=controlled'], full: ['--set=full'] },
        files: [`evals/funnel/${stage}/targets.json`, 'evals/funnel/known-bugs.js'],
    })),
    {
        id: 'business-logic',
        stage: 'business-logic',
        run: ['evals/business-logic/run.js'],
        sets: { controlled: [], full: null },
        files: ['evals/business-logic/targets.json', 'evals/business-logic/cases.json'],
    },
    {
        id: 'memories',
        stage: 'memories',
        run: ['evals/memories/run.js'],
        sets: { controlled: [], full: null },
        files: ['evals/memories/targets.json'],
    },
    {
        id: 'custom-agents',
        stage: 'custom-agents',
        run: ['evals/custom-agents/run.js'],
        sets: { controlled: [], full: null },
        files: ['evals/custom-agents/targets.json'],
    },
];

// The finder and Kody Rules keep their own nightly jobs (their own verdicts:
// evals/investigation/confirm-gate.js, evals/kody-rules/nightly-verdict.js);
// the weekly run measures them beside the rest. `verdict` names how a run below
// the floor is confirmed.
const WEEKLY_EVALS = [
    {
        id: 'finder-recall',
        stage: 'finder',
        run: ['evals/investigation/run-recall.js', '--concurrency=6'],
        sets: { controlled: ['--set=controlled'], full: ['--set=full'] },
        verdict: 'finder',
    },
    {
        id: 'kody-rules',
        stage: 'kody-rules',
        run: ['evals/kody-rules/real-agent.js', '--dataset=github-cases', '--runs=1'],
        sets: { controlled: [], full: null },
        verdict: 'kody-rules',
    },
    ...NIGHTLY_EVALS.map((e) => ({ ...e, verdict: 'shared' })),
];

// The nightly's command for an entry: its run on the controlled set.
const nightlyCommand = (e) => [...e.run, ...e.sets.controlled];

const byId = (id) => NIGHTLY_EVALS.find((e) => e.id === id) || null;

module.exports = { NIGHTLY_EVALS, WEEKLY_EVALS, nightlyCommand, byId };
