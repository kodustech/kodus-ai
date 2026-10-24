#!/usr/bin/env node
// Exit 0: corpus ready; 1: invalid labels; 2: not enough measured cases.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = __dirname;
const balanced = process.argv.includes('--balanced');
const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, 'candidates.json'), 'utf8'),
);
const labels = JSON.parse(
    fs.readFileSync(
        path.join(
            dir,
            balanced ? 'adjudications-balanced.json' : 'adjudications.json',
        ),
        'utf8',
    ),
);
const candidates = new Map(manifest.cases.map((entry) => [entry.id, entry]));
const decisions = new Set(['hold', 'eligible', 'uncertain']);
const seen = new Set();
const errors = [];
const scored = [];
const rows = Array.isArray(labels.cases) ? labels.cases : [];

if (balanced) {
    const plan = JSON.parse(
        fs.readFileSync(path.join(dir, 'adjudication-plan.json'), 'utf8'),
    ).ids;
    const selection = JSON.parse(
        fs.readFileSync(path.join(dir, 'balanced-selection.json'), 'utf8'),
    ).ids;
    const expected = [...plan]
        .sort((left, right) => {
            const hash = (id) =>
                crypto.createHash('sha256').update(id).digest('hex');
            return (
                hash(left).localeCompare(hash(right)) ||
                left.localeCompare(right)
            );
        })
        .slice(0, 200);
    if (
        new Set(plan).size !== plan.length ||
        selection.length !== 200 ||
        selection.some((id, index) => id !== expected[index]) ||
        rows.length !== 200 ||
        rows.some((row, index) => row.id !== selection[index])
    ) {
        errors.push('balanced labels must match the frozen SHA-256 selection');
    }
}

if (
    labels.schemaVersion !== 1 ||
    labels.rubricVersion !== 1 ||
    !Array.isArray(labels.cases)
) {
    errors.push('invalid adjudication document version or cases');
}
for (const [index, row] of rows.entries()) {
    const key = `cases[${index}]`;
    const candidate = candidates.get(row.id);
    if (!candidate || seen.has(row.id))
        errors.push(`${key}: unknown or duplicate id`);
    seen.add(row.id);
    if (!decisions.has(row.decision)) errors.push(`${key}: invalid decision`);
    if (
        row.decision !== 'uncertain' &&
        !/^[0-9a-f]{40}$/.test(String(row.snapshotSha))
    ) {
        errors.push(`${key}: invalid snapshotSha`);
    }
    if (
        row.decision !== 'uncertain' &&
        (!row.snapshotAt ||
            Number.isNaN(Date.parse(row.snapshotAt)) ||
            (candidate &&
                Date.parse(row.snapshotAt) < Date.parse(candidate.createdAt)))
    ) {
        errors.push(`${key}: invalid snapshotAt`);
    }
    if (typeof row.rationale !== 'string' || row.rationale.trim().length < 30) {
        errors.push(`${key}: rationale must explain the decision`);
    }
    if (
        !Array.isArray(row.evidence) ||
        row.evidence.length === 0 ||
        row.evidence.some((url) => !/^https:\/\//.test(url))
    ) {
        errors.push(`${key}: at least one HTTPS evidence link is required`);
    }
    if (typeof row.adjudicator !== 'string' || !row.adjudicator.trim()) {
        errors.push(`${key}: adjudicator is required`);
    }
    if (row.decision === 'hold' || row.decision === 'eligible')
        scored.push(row);
}

if (errors.length) {
    errors.forEach((error) => console.error(error));
    process.exit(1);
}
const byDecision = Object.fromEntries(
    ['hold', 'eligible', 'uncertain'].map((decision) => [
        decision,
        rows.filter((row) => row.decision === decision).length,
    ]),
);
const byRepo = new Map();
for (const row of scored) {
    const repository = candidates.get(row.id).repository;
    byRepo.set(repository, (byRepo.get(repository) ?? 0) + 1);
}
const largestShare = scored.length
    ? Math.max(...byRepo.values()) / scored.length
    : 0;
console.log(
    JSON.stringify({
        candidates: candidates.size,
        adjudicated: rows.length,
        scored: scored.length,
        byDecision,
        repositories: byRepo.size,
        largestRepositoryShare: Number(largestShare.toFixed(3)),
    }),
);
if (
    scored.length < 200 ||
    byDecision.hold === 0 ||
    byDecision.eligible === 0 ||
    largestShare > 0.25
) {
    console.error(
        'corpus not measured: need >=200 scored PRs, both decisions, and <=25% from one repository',
    );
    process.exit(2);
}
