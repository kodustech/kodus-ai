#!/usr/bin/env node
// Builds the repo-instructions cases, in memory, from the committed kody-rules
// GitHub cases (evals/kody-rules/github-cases.json): real merged PRs whose
// violations of a convention are enumerated line by line, with the PR as the
// platform returns it (`pr`), which production's review stage reads.
//
// Each case's target branch gets a CLAUDE.md that states the convention the PR
// breaks, plus a decoy instruction the diff never touches. The ground truth is
// the enumerated violation sites; any finding citing the decoy is a false
// positive. The instruction text is written here; the PR, its files and the
// violation sites are real. A case without recorded PR data is left out.
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
    return source.filter((c) => c.pr).map((c) => ({
        caseId: `repo-instructions:${c.caseId}`,
        source: c.source,
        convention: c.rule.rule,
        decoy: DECOY,
        vars: {
            caseId: `repo-instructions:${c.caseId}`,
            prTitle: c.pr.title || c.title,
            prBody: c.pr.body || c.body || '',
            repositoryFullName: c.pr.repositoryFullName,
            prNumber: c.pr.number,
            prHead: { ref: c.pr.headRef, sha: c.pr.headSha },
            prBase: { ref: c.pr.baseRef, sha: c.pr.baseSha },
            prFiles: c.pr.files,
            prCommits: c.pr.commits,
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
