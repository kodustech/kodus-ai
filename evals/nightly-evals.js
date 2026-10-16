// The evals the nightly measures on a real model through its shared job
// (code-review-evals-nightly.yml, `measure-evals`). Adding an entry is how an
// eval gets measured every night one of its files changes. Each one:
//   - writes the shared result with --output (evals/shared/eval-result.js),
//     its metric's floor read from its own targets file;
//   - exits 1 below that floor with --gate, 2 when it did not measure;
//   - measures one stage of evals/stages.js, whose `nightly` is 'shared';
//   - has a wiring smoke step of the same id, whose trace lists its files.
// The shared job measures again below the floor and pools both runs
// (evals/shared/nightly-verdict.js), so every entry alerts the same way.
//
// The finder and kody-rules keep their own jobs.
//
// Every Friday, each entry also runs on every tier-0 model, on a few of its
// cases (evals/tier0-smoke.js): the nightly asks whether a change broke it,
// Friday whether it still runs on each model.
//
//   id     — the eval, and its wiring smoke step
//   stage  — the evals/stages.js stage it measures
//   run    — the command, without --model, --output and --gate
//   files  — what changes its verdict without being loaded by the one-case run
//   friday — what cuts `run` down to a few cases for the Friday check
const NIGHTLY_EVALS = [
    {
        id: 'reply-addressing',
        stage: 'reply-addressing',
        run: ['evals/reply-addressing/run.js', '--dataset=cases', '--repeats=1'],
        files: ['evals/reply-addressing/targets.json'],
        friday: ['--limit=16'],
    },
    {
        id: 'review-rounds',
        stage: 'review-rounds',
        // The BYOK route with reasoning off, where the reposts were measured
        // (#2097), judged by the model the floor was calibrated with.
        run: [
            'evals/review-rounds/run.js',
            '--set=nightly',
            '--reps=2',
            '--byok-reasoning=none',
            '--judge=gemini-3-flash-preview',
            '--concurrency=6',
        ],
        files: [
            'evals/review-rounds/targets.json',
            'evals/review-rounds/cases.js',
            'evals/review-rounds/prod-shapes/build.js',
        ],
        // A Kody Rules repost with a new site, a bug repost and a revision.
        friday: ['--limit=3'],
    },
    {
        id: 'parse',
        stage: 'parse',
        run: ['evals/parse/run.js'],
        files: ['evals/parse/targets.json'],
        // The cases that call the model: findings written as prose.
        friday: ['--limit=4', '--prose'],
    },
    {
        id: 'format',
        stage: 'format',
        run: ['evals/format/run.js'],
        files: ['evals/format/targets.json'],
        // One case of each configuration (five).
        friday: ['--limit=5'],
    },
    {
        id: 'pr-summary',
        stage: 'pr-summary',
        run: ['evals/pr-summary/run.js'],
        files: ['evals/pr-summary/targets.json'],
        // Every case (one call each where a summary is asked for), gated: the
        // routing and posting contract is what died for one model in prod.
        friday: ['--limit=15', '--gate'],
    },
    {
        id: 'conversation',
        stage: 'conversation',
        run: ['evals/conversation/run.js'],
        files: ['evals/conversation/targets.json'],
        friday: ['--limit=4'],
    },
    // Offers are reported beside the number, not gated (evals/thread-actions).
    ...['rule', 'memory'].map((kind) => ({
        id: `thread-${kind}`,
        stage: `thread-${kind}`,
        run: ['evals/thread-actions/run.js', `--kind=${kind}`],
        files: ['evals/thread-actions/targets.json'],
        // A pair asking for nothing but offers, and a pair asking Kody to act.
        friday: ['--limit=4'],
    })),
    // The stages after the finder, on its frozen candidates (evals/funnel):
    // ungated until the relabeled dataset lands (#2114).
    ...['anchoring', 'dedup', 'severity', 'verify'].map((stage) => ({
        id: `funnel-${stage}`,
        stage,
        run: [`evals/funnel/${stage}/run.js`],
        files: [`evals/funnel/${stage}/targets.json`, 'evals/funnel/known-bugs.js'],
        friday: ['--limit=4'],
    })),
    {
        id: 'memories',
        stage: 'memories',
        run: ['evals/memories/run.js'],
        files: ['evals/memories/targets.json'],
        friday: ['--limit=4'],
    },
];

const byId = (id) => NIGHTLY_EVALS.find((e) => e.id === id) || null;

module.exports = { NIGHTLY_EVALS, byId };
