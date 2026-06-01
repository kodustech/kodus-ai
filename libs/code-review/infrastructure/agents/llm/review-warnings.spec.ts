import {
    dedupReviewWarnings,
    type ReviewWarning,
} from './review-warnings';

const w = (
    kind: ReviewWarning['kind'],
    overrides: Partial<ReviewWarning> = {},
): ReviewWarning => ({
    kind,
    reason: 'small_context_window',
    contextWindowTokens: 16_000,
    modelName: 'llama',
    ...overrides,
});

describe('dedupReviewWarnings', () => {
    it('returns empty array unchanged', () => {
        expect(dedupReviewWarnings([])).toEqual([]);
    });

    it('folds identical (kind, modelName, contextWindowTokens) into one entry', () => {
        const out = dedupReviewWarnings([
            w('PROMPT_COMPACTED'),
            w('PROMPT_COMPACTED'),
            w('PROMPT_COMPACTED'),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('PROMPT_COMPACTED');
    });

    it('keeps separate entries when modelName differs (multi-agent runs with different BYOK roles)', () => {
        const out = dedupReviewWarnings([
            w('PROMPT_COMPACTED', { modelName: 'llama-a' }),
            w('PROMPT_COMPACTED', { modelName: 'llama-b' }),
        ]);
        expect(out).toHaveLength(2);
    });

    it('preserves order of first occurrence', () => {
        const out = dedupReviewWarnings([
            w('HEAVY_PASSES_SKIPPED'),
            w('PROMPT_COMPACTED'),
            w('HEAVY_PASSES_SKIPPED'),
        ]);
        expect(out.map((x) => x.kind)).toEqual([
            'HEAVY_PASSES_SKIPPED',
            'PROMPT_COMPACTED',
        ]);
    });

    it('merges `detail` strings when folding — distinct details preserved, comma-joined', () => {
        const out = dedupReviewWarnings([
            w('LOW_SIGNAL_FILES_DROPPED', {
                detail: 'foo.test.ts',
                agentName: 'bug',
            }),
            w('LOW_SIGNAL_FILES_DROPPED', {
                detail: 'bar.test.ts',
                agentName: 'security',
            }),
            w('LOW_SIGNAL_FILES_DROPPED', {
                detail: 'foo.test.ts',
                agentName: 'performance',
            }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].detail).toBe('foo.test.ts, bar.test.ts');
    });

    it('drops agentName on merged entries (cross-agent warning is not agent-specific)', () => {
        const out = dedupReviewWarnings([
            w('PROMPT_COMPACTED', { agentName: 'bug' }),
            w('PROMPT_COMPACTED', { agentName: 'security' }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].agentName).toBeUndefined();
    });
});
