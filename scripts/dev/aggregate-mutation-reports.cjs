#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const shardCount = Number(process.argv[3]);
if (!root || !Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('Expected artifact directory and positive shard count');
}

const counts = { killed: 0, timeout: 0, survived: 0, no_coverage: 0, other: 0 };
const survivors = [];
const missing = [];
let reports = 0;
let low = 60;

for (let index = 0; index < shardCount; index++) {
    const directory = path.join(root, `mutation-report-${index}`);
    const statusPath = path.join(directory, 'status.json');
    const reportPath = path.join(directory, 'mutation.json');
    if (!fs.existsSync(statusPath)) {
        missing.push(index);
        continue;
    }
    const { outcome } = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (outcome !== 'success') {
        missing.push(index);
        continue;
    }
    if (!fs.existsSync(reportPath)) continue; // Shard had no current lines.

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    reports++;
    low = report.thresholds?.low ?? low;
    for (const [file, entry] of Object.entries(report.files || {})) {
        for (const mutant of entry.mutants || []) {
            const status = mutant.status;
            if (status === 'Killed') counts.killed++;
            else if (status === 'Timeout') counts.timeout++;
            else if (status === 'Survived') counts.survived++;
            else if (status === 'NoCoverage') counts.no_coverage++;
            else counts.other++;
            if (
                (status === 'Survived' || status === 'NoCoverage') &&
                survivors.length < 15
            ) {
                survivors.push({
                    file,
                    line: mutant.location?.start?.line ?? null,
                    mutator: mutant.mutatorName,
                    status,
                });
            }
        }
    }
}

const valid =
    counts.killed + counts.timeout + counts.survived + counts.no_coverage;
const score = valid
    ? Math.round(((counts.killed + counts.timeout) / valid) * 10000) / 100
    : null;
const status = missing.length
    ? 'infra'
    : score === null
      ? 'skipped'
      : score < low
        ? 'yellow'
        : 'green';
const meta = { ...counts, valid, low, reports, shardCount, missing, survivors };
const outputs = {
    status,
    value: status === 'infra' || score === null ? '' : String(score),
    meta: JSON.stringify(meta),
};
if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(outputs)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
    );
}
console.log(JSON.stringify({ status, score, ...meta }));
