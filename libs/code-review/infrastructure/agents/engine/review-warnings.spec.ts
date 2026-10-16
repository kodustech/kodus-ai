import {
    dedupReviewWarnings,
    buildProviderFallbackWarning,
    buildRuleContextUnavailableWarning,
    buildBadFixDowngradedWarning,
    buildCallGraphFailedWarning,
    buildKodyRulesPartialWarning,
    buildPathMismatchWarning,
    buildSandboxUnavailableWarning,
    withFallbackWarnings,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';

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

describe('buildProviderFallbackWarning', () => {
    it('builds a PROVIDER_FALLBACK notice naming the failed + used models', () => {
        const warning = buildProviderFallbackWarning({
            failedModel: 'openai_compatible:kimi-bad',
            usedModel: 'openai_compatible:kimi-good',
            agentName: 'generalist',
        });
        expect(warning.kind).toBe('PROVIDER_FALLBACK');
        expect(warning.reason).toBe('provider_failover');
        expect(warning.modelName).toBe('openai_compatible:kimi-good');
        expect(warning.detail).toContain('kimi-bad');
        expect(warning.detail).toContain('kimi-good');
        expect(warning.contextWindowTokens).toBe(0);
    });

    it('folds per-agent fallback notices into one dashboard entry', () => {
        const out = dedupReviewWarnings([
            buildProviderFallbackWarning({
                failedModel: 'main',
                usedModel: 'fb',
                agentName: 'generalist',
            }),
            buildProviderFallbackWarning({
                failedModel: 'main',
                usedModel: 'fb',
                agentName: 'kody-rules',
            }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].kind).toBe('PROVIDER_FALLBACK');
        expect(out[0].agentName).toBeUndefined();
    });
});

describe('buildRuleContextUnavailableWarning', () => {
    it('carries the skipped rule titles as structured data, not only inside `detail`', () => {
        const warning = buildRuleContextUnavailableWarning({
            skippedRuleTitles: ['No god objects', 'Repository per aggregate'],
            modelName: 'gemini',
            agentName: 'kody-rules',
        });
        expect(warning.kind).toBe('RULE_CONTEXT_UNAVAILABLE');
        expect(warning.ruleTitles).toEqual([
            'No god objects',
            'Repository per aggregate',
        ]);
        expect(warning.detail).toContain('2 Kody Rule(s)');
    });

    it('unions rule titles when two emitters fold into one entry', () => {
        const out = dedupReviewWarnings([
            buildRuleContextUnavailableWarning({
                skippedRuleTitles: ['A', 'B'],
                modelName: 'gemini',
                agentName: 'kody-rules',
            }),
            buildRuleContextUnavailableWarning({
                skippedRuleTitles: ['B', 'C'],
                modelName: 'gemini',
                agentName: 'kody-rules-2',
            }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].ruleTitles).toEqual(['A', 'B', 'C']);
    });

    it('does not alias the caller\'s array into the warning', () => {
        const titles = ['A'];
        const warning = buildRuleContextUnavailableWarning({
            skippedRuleTitles: titles,
            modelName: 'gemini',
        });
        titles.push('B');
        expect(warning.ruleTitles).toEqual(['A']);
    });
});

describe('buildBadFixDowngradedWarning', () => {
    it('reports the downgraded count in `detail`', () => {
        const warning = buildBadFixDowngradedWarning({
            count: 3,
            modelName: 'gemini',
            agentName: 'bug',
        });
        expect(warning.kind).toBe('BAD_FIX_DOWNGRADED');
        expect(warning.reason).toBe('unusable_fix');
        expect(warning.detail).toContain('3 suggestion(s)');
    });

    it('merges counts from two agents into one dashboard entry via dedup', () => {
        const out = dedupReviewWarnings([
            buildBadFixDowngradedWarning({
                count: 2,
                modelName: 'gemini',
                agentName: 'bug',
            }),
            buildBadFixDowngradedWarning({
                count: 1,
                modelName: 'gemini',
                agentName: 'security',
            }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].agentName).toBeUndefined();
    });
});

describe('losses a review used to record only in its logs (#2066)', () => {
    it('names each loss with its own cause, not a small context window', () => {
        const all = [
            buildSandboxUnavailableWarning({ modelName: 'gpt-4.1' }),
            buildCallGraphFailedWarning({ modelName: 'gpt-4.1' }),
            buildPathMismatchWarning({
                count: 2,
                modelName: 'gpt-4.1',
                agentName: 'bug',
            }),
            buildKodyRulesPartialWarning({
                failed: 1,
                total: 3,
                modelName: 'gpt-4.1',
                agentName: 'kody-rules',
            }),
        ];

        expect(all.map((x) => [x.kind, x.reason])).toEqual([
            ['SANDBOX_UNAVAILABLE', 'sandbox_unavailable'],
            ['CALLGRAPH_FAILED', 'callgraph_failed'],
            ['SUGGESTIONS_DROPPED_PATH_MISMATCH', 'path_mismatch'],
            ['KODY_RULES_PARTIAL', 'judge_shard_failed'],
        ]);
        expect(all.every((x) => x.contextWindowTokens === 0)).toBe(true);
        expect(all[2].detail).toContain('bug: 2 finding(s)');
        expect(all[3].detail).toContain('1 of 3 Kody Rules check(s)');
    });

    it("keeps each agent's path drops when they fold together", () => {
        const [merged] = dedupReviewWarnings([
            buildPathMismatchWarning({
                count: 1,
                modelName: 'gpt-4.1',
                agentName: 'bug',
            }),
            buildPathMismatchWarning({
                count: 1,
                modelName: 'gpt-4.1',
                agentName: 'security',
            }),
        ]);

        expect(merged.detail).toContain('bug: 1');
        expect(merged.detail).toContain('security: 1');
    });
});

describe('withFallbackWarnings', () => {
    it('leaves the warnings untouched when nothing failed over', () => {
        const warnings = [w('PROMPT_COMPACTED')];
        expect(withFallbackWarnings(warnings, [])).toBe(warnings);
        expect(withFallbackWarnings(undefined, [])).toBeUndefined();
    });

    it('adds one fallback warning per model the review fell back to', () => {
        const out = withFallbackWarnings(
            [w('PROMPT_COMPACTED')],
            [
                { failedModel: 'claude-opus', usedModel: 'gpt-4.1' },
                { failedModel: 'claude-opus', usedModel: 'gpt-4.1' },
            ],
        );

        expect(out?.map((x) => x.kind)).toEqual([
            'PROMPT_COMPACTED',
            'PROVIDER_FALLBACK',
        ]);
        expect(out?.[1].detail).toBe(
            'main provider claude-opus failed; review ran on fallback gpt-4.1',
        );
    });
});
