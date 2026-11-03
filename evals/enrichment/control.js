#!/usr/bin/env node
/**
 * Breaks the enrichment judge on purpose: for every item whose reference fix
 * is local, an answer whose improvedCode is the cited code unchanged. The
 * judge (judge.js) must FAIL all of them.
 *
 *   node evals/enrichment/control.js  ->  evals/enrichment/results/control-noop.judged.json
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, 'dataset');
const OUT = path.join(__dirname, 'results', 'control-noop.json');
const items = JSON.parse(fs.readFileSync(path.join(DIR, 'items.json'), 'utf8')).items;
const refs = new Map();
for (const f of fs.readdirSync(path.join(DIR, 'references')).filter((f) => f.endsWith('.json'))) {
    for (const r of JSON.parse(fs.readFileSync(path.join(DIR, 'references', f), 'utf8')).items) refs.set(r.issueId, r);
}
const rows = items
    .filter((it) => it.deterministic.anchorStatus === 'ok' && refs.get(it.issueId)?.fixability === 'local')
    .map((it) => ({ issueId: it.issueId, split: it.split, result: { oneSentenceSummary: 'x', fixStatus: 'local', improvedCode: it.deterministic.existingCode } }));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ model: 'control', variant: 'no-op fix', rows }));
execFileSync('node', [path.join(__dirname, 'judge.js'), OUT], { stdio: 'ignore' });
const judged = JSON.parse(fs.readFileSync(OUT.replace(/\.json$/, '.judged.json'), 'utf8')).rows;
const passed = judged.filter((r) => r.grade?.judge?.fix === 'PASS').map((r) => r.issueId);
console.log(`no-op fixes failed by the judge: ${judged.length - passed.length}/${judged.length}`, passed);
process.exit(passed.length ? 1 : 0);
