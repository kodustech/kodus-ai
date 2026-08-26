import {
    deriveArea,
    deriveTu,
    ROUTING_TASKS,
    SUGGESTION_RUN_NAMES,
    SYSTEM_RUN_NAMES,
} from './token-usage-tu';
import {
    BACKFILL_ROUTING_TASKS,
    BACKFILL_SUGGESTION_RUN_NAMES,
    BACKFILL_SYSTEM_RUN_NAMES,
} from '../infrastructure/database/mongo/token-usage/backfill-tu';
import { LLM_TASK } from '@libs/llm/byok-config';

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
        // Bedrock `:<version>` suffix is stripped to the model, NOT stored as "0"
        // (which collapsed every Bedrock model onto one bucket). Regression.
        expect(
            deriveTu({
                ...usage,
                'gen_ai.response.model':
                    'us.anthropic.claude-3-5-haiku-20241022-v1:0',
            })!.model,
        ).toBe('us.anthropic.claude-3-5-haiku-20241022-v1');
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

        it('captures the routing task from `route` (the per-task dimension)', () => {
            expect(deriveTu({ ...usage, route: 'codeReview' })!.route).toBe(
                'codeReview',
            );
        });

        it('stamped `route` wins over the area de-para', () => {
            // Even in a review-area span, an explicit route is authoritative.
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.run.name': 'code-review-security',
                    route: 'kodyRulesReview',
                })!.route,
            ).toBe('kodyRulesReview');
        });

        it('IGNORES a non-task `route` (stale tier string) → area de-para', () => {
            // A pre-realignment span stamped the TIER ('default'/'taskOverride')
            // in `route`. That is not a valid task, so the per-task view must not
            // show it — fall back to the area de-para instead.
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.run.name': 'code-review-security',
                    route: 'default',
                })!.route,
            ).toBe('codeReview');
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.run.name': 'generateSummaryPR',
                    route: 'taskOverride',
                })!.route,
            ).toBe('prSummary');
        });

        it('BACK-COMPAT: infers the task from area when `route` is absent', () => {
            // Pre-launch spans have no `route` attr → de-para from the area.
            expect(
                deriveTu({ ...usage, 'gen_ai.run.name': 'code-review-security' })!
                    .route,
            ).toBe('codeReview');
            expect(
                deriveTu({ ...usage, 'gen_ai.run.name': 'generateSummaryPR' })!
                    .route,
            ).toBe('prSummary');
            expect(
                deriveTu({
                    ...usage,
                    'gen_ai.run.name': 'kodyRulesAnalyzeCodeWithAI',
                })!.route,
            ).toBe('kodyRulesReview');
            // system/other are not attributable → '' (never undefined).
            expect(deriveTu(usage)!.route).toBe('');
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
        // the review AGENT run-name spells the product "kodus" (with the S) —
        // must still resolve, else it leaks into 'other' → "Unrouted".
        ['kodus-rules-review-agent.shard', 'kody_rules'],
        ['classifierKodyRulesAnalyzeCodeWithAI', 'kody_rules'],
        ['suggestionGenerationKodyRulesAnalyzeCodeWithAI', 'kody_rules'],
        ['prLevelKodyRulesAnalyzer', 'kody_rules'],
        ['generateKodyRules.generate', 'kody_rules'],
        ['extractKodyRuleIdsFromContent', 'kody_rules'],
        ['kodyRulesRecommendationFromSuggestions', 'kody_rules'],
        ['kodyRulesFilesToRulesFastBatch', 'kody_rules'],
        ['kodyMemoryResolution', 'kody_rules'],
        // generalist review agents — every leaf model call the harness review
        // makes carries a `code-review-*` runName so LLM.run's ONE usage span
        // lands in `review` (there is no separate aggregate span anymore).
        ['code-review-security', 'review'],
        ['code-review-bug-verify', 'review'],
        ['code-review-bug-recovery', 'review'],
        ['code-review-dedup', 'review'],
        ['analyzeCodeWithAI', 'review'],
        ['analyzeCodeWithAI_v2', 'review'],
        // suggestion refinement — current run-names + legacy
        ['severity-classifier', 'suggestions'],
        ['suggestion-formatter', 'suggestions'],
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
        expect(new Set(BACKFILL_ROUTING_TASKS)).toEqual(ROUTING_TASKS);
    });

    it('ROUTING_TASKS matches the real LlmTask enum', () => {
        // The guard must trust exactly the valid tasks — no more (would let a
        // garbage value through), no fewer (would de-para a real task away).
        expect(ROUTING_TASKS).toEqual(new Set(Object.values(LLM_TASK)));
    });
});
