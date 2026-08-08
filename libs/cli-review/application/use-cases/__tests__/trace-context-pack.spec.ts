import {
    filterDecisionsForChangedFiles,
    injectTraceContextPack,
    renderTraceContextPack,
    selectTraceContextPack,
    TRACE_CONTEXT_PACK_TOKEN_BUDGET,
    type TraceDecision,
} from '../trace-context-pack';

function d(
    partial: Partial<TraceDecision> & { id: string; decision: string },
): TraceDecision {
    return {
        type: 'implementation_detail',
        confidence: 0.5,
        ...partial,
    };
}

describe('trace-context-pack', () => {
    const decisions: TraceDecision[] = [
        d({
            id: 'a',
            decision: 'Use JWT for auth',
            paths: ['src/auth/jwt.ts'],
            confidence: 0.9,
            type: 'architectural_decision',
        }),
        d({
            id: 'b',
            decision: 'Invoice uses decimal',
            paths: ['src/billing/invoice.ts'],
            confidence: 0.8,
        }),
        d({
            id: 'c',
            decision: 'Unrelated logging format',
            paths: ['src/logging/format.ts'],
            confidence: 0.95,
        }),
        d({
            id: 'pin',
            decision: 'Pinned low-confidence but must survive',
            paths: ['src/auth/jwt.ts'],
            confidence: 0.1,
            pinned: true,
        }),
    ];

    it('scopes to changed files only', () => {
        const pack = selectTraceContextPack(decisions, ['src/auth/jwt.ts']);
        const ids = pack.map((x) => x.id).sort();
        expect(ids).toEqual(['a', 'pin']);
        expect(ids).not.toContain('b');
        expect(ids).not.toContain('c');
    });

    it('is inert when no decisions match — prompt byte-identical', () => {
        const prompt = 'REVIEW THIS DIFF\n\n@@ -1 +1 @@\n';
        const selected = selectTraceContextPack(decisions, [
            'src/totally/unrelated.ts',
        ]);
        const rendered = renderTraceContextPack(selected);
        expect(rendered).toBe('');
        const injected = injectTraceContextPack(prompt, rendered);
        expect(injected).toBe(prompt);
        expect(injected === prompt).toBe(true);
    });

    it('drops lowest confidence first under budget and never drops pinned', () => {
        // Build many high-token decisions so budget is exceeded
        const bulky: TraceDecision[] = [
            d({
                id: 'pin',
                decision: 'PINNED ' + 'x'.repeat(200),
                paths: ['src/a.ts'],
                confidence: 0.01,
                pinned: true,
            }),
            d({
                id: 'high',
                decision: 'HIGH ' + 'y'.repeat(4000),
                paths: ['src/a.ts'],
                confidence: 0.99,
            }),
            d({
                id: 'low',
                decision: 'LOW ' + 'z'.repeat(4000),
                paths: ['src/a.ts'],
                confidence: 0.1,
            }),
        ];

        const pack = selectTraceContextPack(
            bulky,
            ['src/a.ts'],
            TRACE_CONTEXT_PACK_TOKEN_BUDGET,
        );
        expect(pack.some((x) => x.id === 'pin')).toBe(true);
        // low should be preferred to drop over high
        if (pack.length < 3) {
            expect(pack.some((x) => x.id === 'low')).toBe(false);
        }
    });

    it('filters forgotten decisions', () => {
        const withForgotten = [
            d({
                id: 'f',
                decision: 'gone',
                paths: ['src/a.ts'],
                forgotten: true,
            }),
        ];
        expect(
            filterDecisionsForChangedFiles(withForgotten, ['src/a.ts']),
        ).toHaveLength(0);
    });

    it('does not import embedding/vector libraries', () => {
        // Structural assertion: no import of embedding deps (comments may mention them)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const src = require('fs').readFileSync(
            require('path').join(__dirname, '../trace-context-pack.ts'),
            'utf-8',
        ) as string;
        expect(src).not.toMatch(
            /from ['"][^'"]*(embed|vector|pinecone|openai)[^'"]*['"]/i,
        );
    });
});
