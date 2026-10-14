#!/usr/bin/env node
// Builds the repo-instructions cases, in memory, from the committed kody-rules
// GitHub cases (evals/kody-rules/github-cases.json): real merged PRs whose
// violations of a convention are enumerated line by line.
//
// Each case gets a CLAUDE.md that states the convention the PR breaks, plus a
// decoy instruction the diff never touches. The ground truth is the enumerated
// violation sites; any finding citing the decoy is a false positive. The
// instruction text is written here; the diffs, files and violation sites are
// real. Built at run time so the 1.6 MB of diffs and replay are not copied.
const fs = require('fs');
const path = require('path');

const SOURCE = path.join(__dirname, '../kody-rules/github-cases.json');

const DECOY =
    'Use pnpm to install dependencies. Never commit a package-lock.json or a yarn.lock.';

function claudeMd(rule) {
    return [
        '# Working in this repository',
        '',
        '## Conventions',
        `- ${rule.rule}`,
        '',
        '## Tooling',
        `- ${DECOY}`,
        '',
    ].join('\n');
}

function buildCases() {
    const source = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
    return source.map((c) => ({
        caseId: `repo-instructions:${c.caseId}`,
        source: c.source,
        convention: c.rule.rule,
        decoy: DECOY,
        vars: {
            caseId: `repo-instructions:${c.caseId}`,
            prTitle: c.title,
            prBody: c.body || '',
            maxSteps: c.maxSteps,
            changedFiles: c.realChangedFiles,
            toolReplay: c.toolReplay,
            repoInstructions: {
                files: [
                    {
                        path: 'CLAUDE.md',
                        content: claudeMd(c.rule),
                        appliesTo: '**',
                        truncated: false,
                    },
                ],
                otherFiles: [],
                dropped: [],
                truncated: false,
                indexedCount: 1,
            },
        },
        groundTruth: c.groundTruth,
    }));
}

module.exports = { buildCases, DECOY };
