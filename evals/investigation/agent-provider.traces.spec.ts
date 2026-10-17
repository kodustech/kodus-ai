// The findings the verifier refuted are kept in the case's output, so a
// golden the run missed can be told apart: never found, or found and refuted.
const { internals } = require('./agent-provider');

const dropped = (file: string) => ({
    relevantFile: file,
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    suggestionContent: `refuted finding in ${file}`,
});

const loop = (file: string) => ({
    result: {
        findings: { reasoning: '', suggestions: [] },
        droppedByVerify: [dropped(file)],
        usage: {},
    },
});

describe('investigation agent provider — refuted findings', () => {
    it('keeps every batch’s refuted findings when a review runs in batches', () => {
        const combined = internals.combineLoops([loop('a.py'), loop('b.py')]);
        expect(
            combined.droppedByVerify.map(
                (d: { relevantFile: string }) => d.relevantFile,
            ),
        ).toEqual(['a.py', 'b.py']);
    });

    it('writes them with their file, lines and text', () => {
        expect(internals.refutedFindings(loop('a.py').result)).toEqual([
            {
                path: 'a.py',
                startLine: 10,
                endLine: 12,
                description: 'refuted finding in a.py',
            },
        ]);
    });
});

describe('investigation agent provider — coding-agent instructions', () => {
    const caseData = {
        caseId: 'c1',
        prFiles: [{ filename: 'src/a.ts' }],
        repoInstructions: {
            files: [
                { path: 'CLAUDE.md', content: 'Amounts are integer cents.' },
            ],
        },
    };

    it('puts the case’s instruction files on the target branch', () => {
        expect(internals.prOf(caseData).targetBranchFiles).toEqual({
            'CLAUDE.md': 'Amounts are integer cents.',
        });
    });

    it("serves the target branch's recorded files, pointers included, over the collected list", () => {
        const targetBranchFiles = {
            'CLAUDE.md': 'AI-AGENTS.md',
            'AI-AGENTS.md': 'Use the repository logger.',
        };
        expect(
            internals.prOf({ ...caseData, targetBranchFiles })
                .targetBranchFiles,
        ).toEqual(targetBranchFiles);
    });

    it('turns the setting on only when the case gives instruction files', () => {
        expect(
            internals.teamOf(caseData).codeReviewConfig.configs
                .repoInstructionsEnabled,
        ).toBe(true);
        const { repoInstructions: _, ...off } = caseData;
        expect(internals.teamOf(off).codeReviewConfig).toBeNull();
        expect(internals.prOf(off).targetBranchFiles).toEqual({});
    });
});
