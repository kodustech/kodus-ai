import { AggregateResultsStage } from './aggregate-result.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Input-contract spec for AggregateResultsStage — the deterministic post-LLM
 * merge that flattens per-file and PR-level analysis results into the
 * suggestion buckets the delivery stages read. Guards the shape each result
 * must carry and that empty inputs never fabricate buckets.
 */
describe('AggregateResultsStage — input contract', () => {
    let stage: AggregateResultsStage;

    const base = (overrides: Partial<CodeReviewPipelineContext> = {}) =>
        ({
            organizationAndTeamData: { organizationId: 'org-1' },
            pullRequest: { number: 42 },
            ...overrides,
        }) as unknown as CodeReviewPipelineContext;

    beforeEach(() => {
        stage = new AggregateResultsStage();
    });

    it('flattens file analysis results into valid + discarded suggestions', async () => {
        const context = base({
            fileAnalysisResults: [
                {
                    validSuggestionsToAnalyze: [{ id: 'a' }],
                    discardedSuggestionsBySafeGuard: [{ id: 'x' }],
                },
                {
                    validSuggestionsToAnalyze: [{ id: 'b' }],
                    discardedSuggestionsBySafeGuard: [],
                },
            ],
        } as any);

        const result = await stage.execute(context);

        expect((result as any).validSuggestions).toEqual([{ id: 'a' }, { id: 'b' }]);
        expect((result as any).discardedSuggestions).toEqual([{ id: 'x' }]);
    });

    it('does not fabricate suggestion buckets when there are no file results', async () => {
        const result = await stage.execute(base({ fileAnalysisResults: [] } as any));

        expect((result as any).validSuggestions).toBeUndefined();
        expect((result as any).discardedSuggestions).toBeUndefined();
    });

    it('aggregates PR-level and cross-file suggestions from prAnalysisResults', async () => {
        const context = base({
            prAnalysisResults: {
                validSuggestionsByPR: [{ id: 'p1' }],
                validCrossFileSuggestions: [{ id: 'c1' }],
            },
        } as any);

        const result = await stage.execute(context);

        expect((result as any).validSuggestionsByPR).toEqual([{ id: 'p1' }]);
        expect((result as any).validCrossFileSuggestions).toEqual([{ id: 'c1' }]);
    });

    it('leaves the PR buckets unset when prAnalysisResults is empty', async () => {
        const context = base({
            prAnalysisResults: {
                validSuggestionsByPR: [],
                validCrossFileSuggestions: [],
            },
        } as any);

        const result = await stage.execute(context);

        expect((result as any).validSuggestionsByPR).toBeUndefined();
        expect((result as any).validCrossFileSuggestions).toBeUndefined();
    });
});
