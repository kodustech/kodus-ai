// One-time backfill of the 2026-06-26/27 session results (finder-recall A/B +
// the dedup guard sweep) into the JSONL ledger, before the /tmp run files expire.
// Numbers are from the session's measured runs (see scripts/benchmark notes +
// evals/dedup/EXPERIMENTS.md). Safe to delete after running once.
const { record } = require('./record');

const TS = '2026-06-26';
const FINDER_DS = 'golden-50pr-136g';
const DEDUP_DS = 'golden-39pr-48g';
const JUDGE = 'claude-sonnet-4-6';

// ---- finder-recall A/B (old engine vs #1371 new engine), full 50 PRs ----
const finder = [
    ['gemini-2.5-flash', 'old', 19, 0.443],
    ['gemini-2.5-flash', 'new', 28, 0.414],
    ['gemini-3-flash-preview', 'old', 27, 0.387],
    ['gemini-3-flash-preview', 'new', 54, 0.421],
];
for (const [model, engine, tp, precision] of finder) {
    record({
        eval: 'finder-recall', model, engine, dataset: FINDER_DS, judge: JUDGE, runs: 1,
        metrics: { recall_mean: +(tp / 136).toFixed(3), tp, goldens: 136, precision_mean: precision },
        ts: TS, notes: 'session A/B old vs #1371 new engine (single run each)',
    });
}
// kimi smoke — matched 3 common cases / 6 goldens, directional only
record({ eval: 'finder-recall', model: 'kimi-k2.7-code', engine: 'old', dataset: 'golden-smoke-6g', judge: JUDGE, runs: 1, metrics: { recall_mean: +(1 / 6).toFixed(3), tp: 1, goldens: 6 }, ts: TS, notes: 'smoke 3 cases — directional only' });
record({ eval: 'finder-recall', model: 'kimi-k2.7-code', engine: 'new', dataset: 'golden-smoke-6g', judge: JUDGE, runs: 1, metrics: { recall_mean: +(2 / 6).toFixed(3), tp: 2, goldens: 6 }, ts: TS, notes: 'smoke 3 cases — directional only' });

// ---- dedup guard sweep (gpt-5.4-mini, 39 dedup-relevant PRs) ----
// goldens_lost = real bugs dropped to over-merge; under_merge = residual dup noise.
const dedup = [
    [{}, [1, 2, 6, 3], 2.3, 12, 'baseline (no guard, default temp)'],
    [{ temp: 0 }, [3, 3, 3, 1], 1.8, null, 'temp=0'],
    [{ guard: 'exact', temp: 0 }, [0, 1, 0, 0], 3.2, 10, 'temp=0 + exact'],
    [{ guard: 'exact' }, [1, 1, 0, 0], 4.0, 10, 'exact (default temp, BYOK-real)'],
    [{ guard: 'samefile' }, [2, 2, 0, 1], 3.25, 10.75, 'samefile (default temp)'],
    [{ guard: 'tight', tightRatio: 0.25 }, [0, 0, 0, 0], 6.0, 8, 'tight@0.25'],
    [{ guard: 'content', threshold: 0.25 }, [1, 1, 1, 1, 1, 1], 1.83, 12.17, 'content@0.25'],
    [{ guard: 'content', threshold: 0.3 }, [0, 0, 0, 0, 0, 0], 4.17, 9.83, 'content@0.3 — SHIPPED (#1402)'],
];
for (const [config, lostRuns, under, good, notes] of dedup) {
    const mean = lostRuns.reduce((a, b) => a + b, 0) / lostRuns.length;
    record({
        eval: 'dedup', model: 'gpt-5.4-mini', engine: 'new', config, dataset: DEDUP_DS, judge: JUDGE,
        runs: lostRuns.length,
        metrics: { goldens_lost_mean: +mean.toFixed(2), goldens_lost_runs: lostRuns, under_merge_mean: under, good_dup_mean: good },
        ts: TS, notes,
    });
}

console.log('backfill done.');
