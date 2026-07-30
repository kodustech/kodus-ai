# Eval results ledger

Durable, versioned record of eval runs so per-model / per-config performance is
tracked over time instead of evaporating in `/tmp` each session.

## Layout

One **append-only JSONL** file per eval category — `<eval>.jsonl` (e.g.
`finder-recall.jsonl`, `dedup.jsonl`). One line = one run. JSONL (not a JSON
array) because appends never rewrite the file → clean git diffs, no merge
conflicts when two people record runs.

## Record shape

```json
{
  "eval": "finder-recall",
  "model": "gemini-3-flash-preview",
  "engine": "new",                       // "old" | "new" | a sha | null  (for A/B)
  "config": { "guard": "content", "threshold": 0.3 },
  "dataset": "golden-50pr-136g",         // golden set + version
  "judge": "claude-sonnet-4-6",
  "runs": 6,                             // replications (1 run decides nothing)
  "metrics": { "recall_mean": 0.40, "recall_runs": [..], "precision_mean": 0.42 },
  "ts": "2026-06-26",
  "notes": "..."
}
```

Two rules the schema enforces, both learned the hard way:
1. **Carry the noise** — `runs` + the per-run arrays (`*_runs`), not just a mean.
   These evals are noise-dominated; a single number lies.
2. **Carry comparability** — `model / engine / config / dataset / judge`. Only
   compare like-with-like; never across model/infra drift.

## Use

```js
const { record } = require('./record');
record({ eval: 'finder-recall', model: '…', dataset: '…', metrics: { … }, runs: 4, ts: '…' });
```

```bash
node evals/results/aggregate.js                # leaderboard, all evals
node evals/results/aggregate.js finder-recall  # one eval
```

`Date.now()` is unavailable in some sandboxes — pass `ts` in the record (or set
`EVAL_TS`). `backfill-session.js` seeded the 2026-06 dedup + finder A/B numbers.
