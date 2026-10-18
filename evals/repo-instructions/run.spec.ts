// The gated number scores what the review ships, after its severity and
// quantity filters; what the finder reported before them is a diagnostic.
const { scoreOn, summarize, armOf } = require('./run');

const testCase = {
    caseId: 'repo-instructions:x',
    convention: 'Application code must not read process.env directly.',
    groundTruth: { 'src/a.ts': [{ line: 10 }, { line: 20 }] },
};
const finding = (line: number) => ({
    label: 'repo_instruction',
    relevantFile: 'src/a.ts',
    relevantLinesStart: line,
    relevantLinesEnd: line,
    suggestionContent:
        'CLAUDE.md says "Application code must not read process.env directly."',
});

describe('repo-instructions scoring', () => {
    it('scores the shipped findings and keeps the finder’s own beside them', () => {
        const score = scoreOn(
            testCase,
            [finding(10)],
            [finding(10), finding(20)],
        );

        expect(score).toMatchObject({
            sites: 2,
            sitesCovered: 1,
            instructionFindings: 1,
            loopSitesCovered: 2,
            loopInstructionFindings: 2,
        });
    });

    it('reports the share of the finder’s instruction findings that ship', () => {
        const rows = [
            {
                arm: 'on',
                status: 'ok',
                score: scoreOn(testCase, [], [finding(10), finding(20)]),
            },
        ];

        expect(summarize(rows).on).toMatchObject({
            occurrenceRecall: 0,
            loopOccurrenceRecall: 1,
            shippedRate: 0,
        });
    });
});

// Both arms review the same repository, with the CLAUDE.md on its target
// branch; only the team's setting differs.
describe('repo-instructions arms', () => {
    const testCase = {
        caseId: 'repo-instructions:x',
        vars: {
            caseId: 'repo-instructions:x',
            repoInstructions: { files: [{ path: 'CLAUDE.md', content: 'x' }] },
        },
    };

    it('turns the setting on through the team config in the on arm only', () => {
        const on = armOf(testCase, 'on');
        const off = armOf(testCase, 'off');

        expect(on.teamConfig.configs).toEqual({ repoInstructionsEnabled: true });
        expect(off.teamConfig).toBeNull();
        expect(on.vars.repoInstructions).toEqual(testCase.vars.repoInstructions);
        expect(off.vars.repoInstructions).toEqual(testCase.vars.repoInstructions);
        expect([on.vars.caseId, off.vars.caseId]).toEqual([
            'repo-instructions:x:on',
            'repo-instructions:x:off',
        ]);
    });
});
