const {
    extractCallGraph,
    applyCallGraphVariant,
} = require('./callgraph-context');

describe('call graph evaluation context', () => {
    const graph =
        '<CallGraph><ChangedFunction name="save" file="src/service.ts" lines="1-2" tested="false" status="modified" /></CallGraph>';

    it('extracts the graph recorded inside a real trace input', () => {
        expect(
            extractCallGraph({
                review: {
                    callGraph: graph,
                },
            }),
        ).toBe(graph);
    });

    it('does not manufacture a graph when a trace has none', () => {
        expect(extractCallGraph({ review: { changedFiles: [] } })).toBeNull();
    });

    it('removes captured graph context for the control arm', () => {
        expect(
            applyCallGraphVariant(
                { callGraph: graph, caseId: 'case-a' },
                'off',
            ),
        ).toEqual({ caseId: 'case-a' });
    });

    it('keeps captured graph context for the treatment arm', () => {
        expect(
            applyCallGraphVariant(
                { callGraph: graph, caseId: 'case-a' },
                'captured',
            ),
        ).toEqual({ callGraph: graph, caseId: 'case-a' });
    });

    it('rejects a treatment case without a graph from a real trace', () => {
        expect(() =>
            applyCallGraphVariant({ caseId: 'case-a' }, 'required'),
        ).toThrow('case-a has no captured call graph');
    });
});
