#!/usr/bin/env node
/**
 * Grows the enrichment dataset (#1821) from 100 to 150 items with candidates
 * Astra already classified (extend-dataset.js, astra-references.js
 * --items=candidates.json):
 *   - fixable (local + context sufficient): 27 more, to 100;
 *   - needs-wider-change: 14 more, to 30;
 *   - insufficient context and no-code-fix: all 9, to 20.
 * The two last groups are where the expected answer is no code at all.
 * Draws are seeded and proportional to the repo mix of each candidate group.
 *
 *   node evals/enrichment/pick-extension.js
 *     -> appends to dataset/items.json and dataset/references/<caseId>.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'dataset');
const SEED = 'enrichment-v2';
const WANT = { fixable: 27, wider: 14, nocode: Infinity };
const rand = (s) => parseInt(crypto.createHash('sha256').update(`${SEED}|${s}`).digest('hex').slice(0, 12), 16) / 2 ** 48;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const refsIn = (d) => new Map(fs.readdirSync(d).filter((f) => f.endsWith('.json')).flatMap((f) => read(path.join(d, f)).items.map((r) => [r.issueId, r])));

const dataset = read(path.join(DIR, 'items.json'));
const have = new Set(dataset.items.map((x) => x.issueId));
if (dataset.items.length !== 100) throw new Error(`expected the 100-item dataset, found ${dataset.items.length}`);
const cands = read(path.join(DIR, 'candidates.json')).items.filter((x) => !have.has(x.issueId));
const refs = refsIn(path.join(DIR, 'references-candidates'));
const group = (r) => (r.fixability === 'local' ? (r.contextSufficient ? 'fixable' : 'nocode') : r.fixability === 'needs-wider-change' ? 'wider' : 'nocode');

const picked = [];
for (const [g, n] of Object.entries(WANT)) {
    const pool = cands.filter((x) => group(refs.get(x.issueId)) === g);
    if (n === Infinity || n >= pool.length) {
        picked.push(...pool);
        continue;
    }
    // Largest remainder per repo, then a seeded draw inside each repo.
    const byRepo = {};
    for (const x of pool) (byRepo[x.repo] ||= []).push(x);
    const alloc = Object.entries(byRepo).map(([repo, xs]) => ({ repo, xs, q: (xs.length * n) / pool.length }));
    alloc.forEach((a) => (a.n = Math.floor(a.q)));
    let left = n - alloc.reduce((s, a) => s + a.n, 0);
    for (const a of [...alloc].sort((x, y) => y.q - Math.floor(y.q) - (x.q - Math.floor(x.q)) || rand(x.repo) - rand(y.repo))) {
        if (left-- <= 0) break;
        a.n++;
    }
    for (const a of alloc) picked.push(...[...a.xs].sort((x, y) => rand(`${g}|${x.issueId}`) - rand(`${g}|${y.issueId}`)).slice(0, a.n));
}

dataset.version = SEED;
dataset.items.push(...picked);
fs.writeFileSync(path.join(DIR, 'items.json'), JSON.stringify(dataset, null, 1));
for (const [caseId, ids] of Object.entries(picked.reduce((m, x) => ((m[x.caseId] ||= []).push(x.issueId), m), {}))) {
    const f = path.join(DIR, 'references', `${caseId}.json`);
    const prev = fs.existsSync(f) ? read(f).items : [];
    fs.writeFileSync(f, JSON.stringify({ caseId, items: [...prev, ...ids.map((id) => refs.get(id))] }, null, 1));
}

const all = refsIn(path.join(DIR, 'references'));
const count = (xs, fn) => xs.reduce((m, x) => ((m[fn(x)] = (m[fn(x)] || 0) + 1), m), {});
console.log({
    added: picked.length,
    items: dataset.items.length,
    group: count(dataset.items, (x) => group(all.get(x.issueId))),
    addedByGroupRepo: count(picked, (x) => `${group(refs.get(x.issueId))}|${x.repo}`),
});
