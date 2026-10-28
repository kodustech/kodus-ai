#!/usr/bin/env node
// Create a candidate pool, not approval labels, from a pinned SWRench source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCE_COMMIT = '67ae1d4395ac05f800d62b0e13678eadeb9fa5c7';
const SOURCE_SHA256 =
    '7048e7a92ea9f7a1e6812646694a040582448cc1dd9d515264a4b55071aff95d';
const EXPECTED = { candidates: 356, functional: 124, noFinding: 232 };
const sourcePath = process.argv[2];
if (!sourcePath) {
    console.error(
        'usage: node evals/approval-risk/seed-candidates.js <swr_datasets_d5c5.jsonl>',
    );
    process.exit(2);
}

const source = fs.readFileSync(sourcePath);
const sha256 = crypto.createHash('sha256').update(source).digest('hex');
if (sha256 !== SOURCE_SHA256) {
    console.error(
        `source checksum mismatch: expected ${SOURCE_SHA256}, got ${sha256}`,
    );
    process.exit(2);
}

const seen = new Set();
const cases = [];
let functional = 0;
let noFinding = 0;
for (const line of source.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (String(row.created_at).slice(0, 4) < '2020') continue;
    const hasFunctionalFinding = (row.changes ?? []).some((change) =>
        String(change.change_type ?? '').startsWith('F.'),
    );
    const hasNoFinding = row.change_introduced === false;
    if (!hasFunctionalFinding && !hasNoFinding) continue;

    const number = Number(String(row.instance_id).match(/-(\d+)$/)?.[1]);
    const id = `${row.repo}#${number}`;
    if (
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        seen.has(id) ||
        !/^[0-9a-f]{40}$/.test(String(row.base_commit)) ||
        Number.isNaN(Date.parse(row.created_at))
    ) {
        throw new Error(`invalid or duplicate source row: ${row.instance_id}`);
    }
    seen.add(id);
    if (hasFunctionalFinding) functional += 1;
    else noFinding += 1;
    cases.push({
        id,
        repository: row.repo,
        prNumber: number,
        url: `https://github.com/${row.repo}/pull/${number}`,
        createdAt: row.created_at,
        baseSha: row.base_commit,
    });
}

if (
    cases.length !== EXPECTED.candidates ||
    functional !== EXPECTED.functional ||
    noFinding !== EXPECTED.noFinding
) {
    throw new Error(
        `unexpected selection: ${cases.length} candidates, ${functional} functional, ${noFinding} no-finding`,
    );
}
cases.sort(
    (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
);
const manifest = {
    schemaVersion: 1,
    source: {
        repository: 'ZZR0/SWRench',
        commit: SOURCE_COMMIT,
        file: 'data/swr_datasets_d5c5.jsonl',
        sha256: SOURCE_SHA256,
    },
    cases,
};
const outPath = path.join(__dirname, 'candidates.json');
fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 4)}\n`);
console.log(`wrote ${cases.length} candidates to ${outPath}`);
