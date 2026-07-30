// Append one eval result to evals/results/<eval>.jsonl (append-only — one line
// per run, so git diffs stay clean and parallel runs never conflict).
//
// Usage (programmatic):
//   const { record } = require('./record');
//   record({ eval: 'finder-recall', model: 'gemini-3-flash-preview', engine: 'new',
//            dataset: 'golden-50pr-136g', judge: 'claude-sonnet-4-6', runs: 6,
//            metrics: { recall_mean: 0.40, recall_runs: [...] }, notes: '...' });
//
// A record MUST carry enough to (a) see the noise — `runs` + per-run arrays, not
// just a mean — and (b) only compare like-with-like (model / engine / config /
// dataset / judge). A single number without this context lies.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const REQUIRED = ['eval', 'model', 'dataset', 'metrics'];

function record(rec) {
    for (const k of REQUIRED) {
        if (rec[k] === undefined) throw new Error(`record missing required field: ${k}`);
    }
    // ts is passed in (Date.now is unavailable in some sandboxes); default to env or a marker.
    const row = {
        eval: rec.eval,
        model: rec.model,
        engine: rec.engine ?? null, // "old" | "new" | sha | null
        config: rec.config ?? {}, // eval-specific knobs (guard, threshold, temp…)
        dataset: rec.dataset,
        judge: rec.judge ?? null,
        runs: rec.runs ?? (Array.isArray(Object.values(rec.metrics)[0]) ? Object.values(rec.metrics)[0].length : 1),
        metrics: rec.metrics,
        ts: rec.ts ?? process.env.EVAL_TS ?? '',
        notes: rec.notes ?? '',
    };
    const file = path.join(DIR, `${rec.eval}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    return file;
}

module.exports = { record };
