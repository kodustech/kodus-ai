import {
    deriveArea,
    deriveTu,
    SUGGESTION_RUN_NAMES,
    SYSTEM_RUN_NAMES,
} from './token-usage-tu';
import {
    BACKFILL_SUGGESTION_RUN_NAMES,
    BACKFILL_SYSTEM_RUN_NAMES,
} from '../infrastructure/database/mongo/token-usage/backfill-tu';

/**
 * `deriveTu` is the single source of the `attributes.tu` sub-doc mirrored onto
 * every LLM-usage span. It must be a faithful, pure function of the same span
 * attributes the Token Usage read pipeline consumes — otherwise the covered
 * aggregation would report different numbers than the legacy $getField path.
 */
describe('deriveTu', () => {
    const usage = {
        'gen_ai.usage.total_tokens': 11921,
        'gen_ai.usage.input_tokens': 8757,
        'gen_ai.usage.output_tokens': 1131,
        'gen_ai.usage.reasoning_tokens': 1860,
        'gen_ai.usage.cache_read_input_tokens': 2721,
        'gen_ai.usage.cache_creation_input_tokens': 2792,
        'gen_ai.response.model': 'claude-sonnet-5',
    };

    it('returns null for spans without LLM usage', () => {
        expect(deriveTu(undefined)).toBeNull();
        expect(deriveTu(null)).toBeNull();
        expect(deriveTu({})).toBeNull();
        expect(deriveTu({ 'gen_ai.usage.total_tokens': 0 })).toBeNull();
        expect(
            deriveTu({ 'gen_ai.response.model': 'x' } as any),
        ).toBeNull();
    });

    it('mirrors token counts verbatim, defaulting missing fields to 0', () => {
        const tu = deriveTu({
            'gen_ai.usage.total_tokens': 100,
            'gen_ai.usage.input_tokens': 60,
            'gen_ai.response.model': 'claude-sonnet-5',
        })!;
        expect(tu.total).toBe(100);
        expect(tu.input).toBe(60);
        expect(tu.output).toBe(0);
        expect(tu.reasoning).toBe(0);
        expect(tu.cacheRead).toBe(0);
        expect(tu.cacheWrite).toBe(0);
    });

    it('copies every token field when present', () => {
        const tu = deriveTu(usage)!;
        expect(tu).toMatchObject({
            input: 8757,
            output: 1131,
            total: 11921,
            reasoning: 1860,
            cacheRead: 2721,
            cacheWrite: 2792,
        });
    });

    it('canonicalizes the model to the last ":"-segment', () => {
        expect(
            deriveTu({ ...usage, 'gen_ai.response.model': 'google_gemini:gemini-2.5-pro' })!
                .model,
        ).toBe('gemini-2.5-pro');
        expect(
            deriveTu({ ...usage, 'gen_ai.response.model': 'openai:gpt-5' })!.model,
        ).toBe('gpt-5');
        // bare name (no provider prefix) is unchanged
        expect(deriveTu(usage)!.model).toBe('claude-sonnet-5');
    });

    describe('byok view flags', () => {
        it('isByok reflects attributes.type === "byok"', () => {
            expect(deriveTu({ ...usage, type: 'byok' })!.isByok).toBe(true);
            expect(deriveTu({ ...usage, type: 'system' })!.isByok).toBe(false);
            expect(deriveTu(usage)!.isByok).toBe(false);
        });

        it('stamps the process area from the run name', () => {
            expect(
                deriveTu({ ...usage, 'gen_ai.run.name': 'code-review-security' })!
                    .area,
            ).toBe('review');
            expect(deriveTu(usage)!.area).toBe('other');
        });

        it('sys is true only for the internal system-analysis run-names', () => {
            for (const name of SYSTEM_RUN_NAMES) {
                expect(
                    deriveTu({ ...usage, 'gen_ai.run.name': name })!.sys,
                ).toBe(true);
            }
            expect(
                deriveTu({ ...usage, 'gen_ai.run.name': 'code-review-security' })!
                    .sys,
            ).toBe(false);
            expect(deriveTu(usage)!.sys).toBe(false);
        });
    });
});

/**
 * `deriveArea` maps every usage span onto the small fixed TokenUsageArea set.
 * The cases below pin one representative run-name per producer family (see
 * the full inventory in issue #1453 / the observability call sites).
 */
describe('deriveArea', () => {
    const cases: Array<[string, string]> = [
        // system (SYSTEM_RUN_NAMES wins even over other rules)
        ['selectReviewMode', 'system'],
        ['generateCodeSuggestions', 'system'],
        // kody rules — analysis, sharded classifiers, PR-level, generation, sync
        ['kodyRulesAnalyzeCodeWithAI', 'kody_rules'],
        ['classifierKodyRulesAnalyzeCodeWithAI', 'kody_rules'],
        ['suggestionGenerationKodyRulesAnalyzeCodeWithAI', 'kody_rules'],
        ['prLevelKodyRulesAnalyzer', 'kody_rules'],
        ['generateKodyRules.generate', 'kody_rules'],
        ['extractKodyRuleIdsFromContent', 'kody_rules'],
        ['kodyRulesRecommendationFromSuggestions', 'kody_rules'],
        ['kodyRulesFilesToRulesFastBatch', 'kody_rules'],
        ['kodyMemoryResolution', 'kody_rules'],
        // cross-file
        ['crossFileAnalyzeCodeWithAI', 'cross_file'],
        ['crossFileContextPlanner', 'cross_file'],
        ['crossFileContextSufficiency', 'cross_file'],
        // generalist review agents
        ['code-review-security', 'review'],
        ['code-review-bug-verify', 'review'],
        ['code-review-dedup', 'review'],
        ['analyzeCodeWithAI', 'review'],
        ['analyzeCodeWithAI_v2', 'review'],
        // suggestion refinement
        ['severityAnalysis', 'suggestions'],
        ['validateWithLLM', 'suggestions'],
        ['checkSuggestionSimplicity', 'suggestions'],
        ['safeguardAgentVerification_turn2', 'suggestions'],
        ['repeatedCodeReviewSuggestionClustering', 'suggestions'],
        // PR summary
        ['generateSummaryPR', 'summary'],
        ['generateSummaryPR_chunk_3', 'summary'],
        ['generateSummaryPR_consolidation', 'summary'],
        // conversation
        ['conversationAgent', 'conversation'],
        // everything else
        ['businessRulesVerify', 'other'],
        ['kodus-web-search-fetcher', 'other'],
        ['documentationPlanner:src/index.ts', 'other'],
        ['commentCategorizer', 'other'],
        ['', 'other'],
    ];

    it.each(cases)('%s → %s', (runName, area) => {
        expect(deriveArea(runName)).toBe(area);
    });

    it('classifies conversation via agent.phase when the run name is custom', () => {
        expect(deriveArea('someCustomRun', 'conversation')).toBe(
            'conversation',
        );
    });

    it('handles non-string input', () => {
        expect(deriveArea(undefined)).toBe('other');
        expect(deriveArea(42 as any)).toBe('other');
    });

    // The Mongo backfill mirrors deriveArea as an aggregation $switch with its
    // own copies of the run-name lists — if these drift, history and new
    // writes would disagree on where tokens went.
    it('stays in sync with the backfill run-name lists', () => {
        expect(new Set(BACKFILL_SYSTEM_RUN_NAMES)).toEqual(
            new Set(SYSTEM_RUN_NAMES),
        );
        expect(new Set(BACKFILL_SUGGESTION_RUN_NAMES)).toEqual(
            new Set(SUGGESTION_RUN_NAMES),
        );
    });
});
