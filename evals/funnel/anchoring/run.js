#!/usr/bin/env node
// funnel/anchoring: the frozen candidates that survived verify (snapshot.js)
// through the production anchoring: the mapper's path check on the PR's changed
// files (`mapAgentFindings`, finding-mapper.ts) and the line snap to the diff
// (`snapLinesToDiff`, agent-review.stage.ts), which drops a finding whose lines
// touch no hunk. A known bug is lost when every finding that matches it is
// dropped. No model call.
const { main } = require('../stage-run');
const { datasetFor } = require('../known-bugs');
const { validRangesFromEnginePatch } = require('../../anchoring/valid-ranges');

const norm = (f) => String(f || '').replace(/\\/g, '/').replace(/^\/+/, '');

main({
    id: 'anchoring',
    apply: async (input, caseId) => {
        const { mapAgentFindings } = require('../../../libs/code-review/infrastructure/agents/collaborators/finding-mapper.ts');
        const { snapLinesToDiff } = require('../../../libs/code-review/pipeline/stages/agent-review.stage.ts');
        const vars = datasetFor(caseId);
        const files = typeof vars.changedFiles === 'string' ? JSON.parse(vars.changedFiles) : vars.changedFiles;
        const suggestions = input.map((c) => ({ ...c.finding }));
        const { suggestions: mapped } = mapAgentFindings({ findings: { reasoning: '', suggestions } }, {
            changedFiles: files.map((f) => ({ filename: f.filename })),
            kodyRules: [],
            prNumber: 1,
            isKodyRules: false,
            identityName: 'funnel-anchoring',
            labelPolicy: { categoryLabel: 'generalist', allowedLabels: ['bug', 'security', 'performance'], supportsMixed: true },
        });
        const ranges = new Map(files.map((f) => [norm(f.filename), validRangesFromEnginePatch(f.patchWithLinesStr)]));
        const kept = [];
        for (const s of mapped) {
            if (snapLinesToDiff(s, ranges.get(norm(s.relevantFile)) || []) === null) continue;
            // The mapper copies each finding; its description identifies it.
            const k = input.findIndex((c, j) => !kept.includes(j) && c.finding.suggestionContent === s.suggestionContent);
            if (k >= 0) kept.push(k);
        }
        return kept;
    },
});
