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
//   id    — the eval, and its wiring smoke step
//   stage — the evals/stages.js stage it measures
//   run   — the command, without --model, --output and --gate
//   files — what changes its verdict without being loaded by the one-case run
const NIGHTLY_EVALS = [
    {
        id: 'reply-addressing',
        stage: 'reply-addressing',
        run: ['evals/reply-addressing/run.js', '--dataset=cases', '--repeats=1'],
        files: ['evals/reply-addressing/targets.json'],
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
    },
];

const byId = (id) => NIGHTLY_EVALS.find((e) => e.id === id) || null;

module.exports = { NIGHTLY_EVALS, byId };
