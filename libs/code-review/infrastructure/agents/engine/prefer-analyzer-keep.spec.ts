import { ANALYZER_SOURCE } from '@libs/code-review/infrastructure/analyzers/analyzer-findings-to-suggestions';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { preferAnalyzerKeep } from './prefer-analyzer-keep';

const agent = (summary: string): Partial<CodeSuggestion> => ({
    oneSentenceSummary: summary,
});

const analyzer = (summary: string): Partial<CodeSuggestion> => ({
    oneSentenceSummary: summary,
    evidence: { source: ANALYZER_SOURCE, ruleId: 'osv/GHSA-aaa' } as any,
});

describe('preferAnalyzerKeep', () => {
    /**
     * The dedup model picks whichever finding reads best, which is always the
     * model's own prose. Measured on a real PR: betterleaks reported ten
     * committed credentials and the group kept the agent's paraphrase, so the
     * published comment carried no scanner provenance at all — and when the
     * agent misses what the scanner caught, nothing is published.
     */
    it('promotes a deterministic duplicate over the model it was merged into', () => {
        const suggestions = [
            agent('hardcoded secrets'),
            analyzer('10 credentials committed'),
        ];

        expect(
            preferAnalyzerKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 1, duplicates: [0] }]);
    });

    it('leaves a group that already keeps the deterministic finding', () => {
        const suggestions = [
            analyzer('10 credentials committed'),
            agent('hardcoded secrets'),
        ];

        expect(
            preferAnalyzerKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('leaves a group with no deterministic finding in it', () => {
        const suggestions = [agent('one'), agent('two')];

        expect(
            preferAnalyzerKeep([{ keep: 0, duplicates: [1] }], suggestions),
        ).toEqual([{ keep: 0, duplicates: [1] }]);
    });

    it('keeps the first deterministic finding when a group holds several', () => {
        const suggestions = [agent('a'), analyzer('b'), analyzer('c')];

        expect(
            preferAnalyzerKeep([{ keep: 0, duplicates: [1, 2] }], suggestions),
        ).toEqual([{ keep: 1, duplicates: [0, 2] }]);
    });

    /** Index validation belongs to the caller; this must not throw on junk. */
    it('passes a group with out-of-range indices through untouched', () => {
        const suggestions = [agent('a')];

        expect(
            preferAnalyzerKeep([{ keep: 9, duplicates: [7] }], suggestions),
        ).toEqual([{ keep: 9, duplicates: [7] }]);
    });

    it('preserves the order of the groups it was given', () => {
        const suggestions = [
            agent('a'),
            analyzer('b'),
            agent('c'),
            analyzer('d'),
        ];

        expect(
            preferAnalyzerKeep(
                [
                    { keep: 0, duplicates: [1] },
                    { keep: 2, duplicates: [3] },
                ],
                suggestions,
            ),
        ).toEqual([
            { keep: 1, duplicates: [0] },
            { keep: 3, duplicates: [2] },
        ]);
    });
});
