// Render a leaderboard from evals/results/*.jsonl. Reads every category file,
// groups by eval, and prints the key metric per (model, engine, config).
//
//   node evals/results/aggregate.js              # all evals
//   node evals/results/aggregate.js finder-recall # one eval
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const only = process.argv[2];

// Which metric headlines each eval (mean + show the spread when present).
const HEADLINE = {
    'finder-recall': ['recall_mean', 'precision_mean'],
    dedup: ['goldens_lost_mean', 'under_merge_mean'],
};

function fmt(v) {
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3);
    return String(v ?? '—');
}

function configStr(c) {
    const e = Object.entries(c || {});
    return e.length ? e.map(([k, v]) => `${k}=${v}`).join(',') : '';
}

const files = fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.jsonl') && (!only || f === `${only}.jsonl`));

if (!files.length) {
    console.log(only ? `no results for eval '${only}'` : 'no .jsonl results yet');
    process.exit(0);
}

for (const file of files) {
    const evalName = file.replace(/\.jsonl$/, '');
    const rows = fs
        .readFileSync(path.join(DIR, file), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    const keys = HEADLINE[evalName] || Object.keys(rows[0].metrics);

    console.log(`\n════ ${evalName} (${rows.length} runs) ════`);
    const header = ['model', 'engine', 'config', ...keys, 'runs', 'ts'];
    const width = (h) => (h === 'model' ? 24 : h === 'config' ? 32 : h === 'engine' ? 7 : h === 'runs' ? 6 : h === 'ts' ? 12 : 18);
    const line = (cells) => cells.map((c, i) => String(c ?? '—').padEnd(width(header[i]))).join('');
    console.log(line(header));
    for (const r of rows) {
        console.log(line([
            (r.model || '').slice(0, 23),
            r.engine ?? '—',
            configStr(r.config) || '—',
            ...keys.map((k) => fmt(r.metrics[k])),
            r.runs,
            (r.ts || '').slice(0, 10),
        ]));
    }
}
