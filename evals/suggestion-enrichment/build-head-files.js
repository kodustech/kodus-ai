#!/usr/bin/env node
// Writes dataset/head-files.json: each cited file of the enrichment dataset
// (evals/enrichment/dataset/items.json) at its PR head, read from the local
// checkouts the dataset was built from (evals/dedup/gold-v3/trabalho/repos.json).
// The eval gives production the whole file, as the review does; CI has no
// checkouts, so the files ship with the eval.
//
//   node evals/suggestion-enrichment/build-head-files.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPOS = JSON.parse(fs.readFileSync(path.join(__dirname, '../dedup/gold-v3/trabalho/repos.json'), 'utf8'));
const { items } = require('../enrichment/dataset/items.json');

const files = {};
for (const it of items) {
    const key = `${it.caseId}|${it.finding.relevantFile}`;
    if (key in files) continue;
    const repo = REPOS[it.caseId];
    if (!repo) throw new Error(`no checkout for ${it.caseId}`);
    files[key] = execFileSync('git', ['-C', repo.repo, 'show', `${it.headSha}:${it.finding.relevantFile}`], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
    });
}
fs.writeFileSync(path.join(__dirname, 'dataset/head-files.json'), `${JSON.stringify({ version: 1, files }, null, 1)}\n`);
console.log(`${Object.keys(files).length} files`);
