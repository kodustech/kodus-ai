// The findings the verifier refuted are kept in the case's output, so a
// golden the run missed can be told apart: never found, or found and refuted.
const { internals } = require('./agent-provider');

const dropped = (file: string) => ({
    relevantFile: file,
    relevantLinesStart: 10,
    relevantLinesEnd: 12,
    suggestionContent: `refuted finding in ${file}`,
});

const result = (file: string) => ({
    findings: { reasoning: '', suggestions: [] },
    droppedByVerify: [dropped(file)],
    usage: {},
});

describe('investigation agent provider — refuted findings', () => {
    it('keeps every batch’s refuted findings when a review is split', () => {
        const merged = internals.mergeResults([result('a.py'), result('b.py')]);
        expect(
            merged.droppedByVerify.map(
                (d: { relevantFile: string }) => d.relevantFile,
            ),
        ).toEqual(['a.py', 'b.py']);
    });

    it('saves the refuted findings in the case output', () => {
        const output = internals.serializeResult(
            'case-1',
            result('a.py'),
            { calls: [], unexpectedCalls: [] },
            null,
            null,
        );
        expect(output.trace.droppedByVerify).toEqual([
            {
                path: 'a.py',
                startLine: 10,
                endLine: 12,
                description: 'refuted finding in a.py',
            },
        ]);
    });
});
