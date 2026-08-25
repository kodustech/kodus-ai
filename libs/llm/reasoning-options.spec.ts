import { BYOKProvider } from '@libs/llm/model-providers';

import {
    buildProviderOptions,
    buildReasoningProviderOptions,
    structuredOutputForcesToolChoice,
    EFFORT_TO_BUDGET,
    type ReasoningEffort,
} from '@libs/llm/reasoning-options';

describe('structuredOutputForcesToolChoice (registry-backed)', () => {
    // Anthropic-protocol providers implement structured output as forced tool_choice
    // → incompatible with thinking. Every OTHER transport uses json_schema /
    // responseSchema and is safe.
    const cases: Array<{
        name: string;
        provider?: BYOKProvider | string;
        model?: string;
        expected: boolean;
    }> = [
        { name: 'anthropic (native)', provider: BYOKProvider.ANTHROPIC, expected: true },
        { name: 'anthropic_compatible', provider: BYOKProvider.ANTHROPIC_COMPATIBLE, expected: true },
        { name: 'moonshot (Kimi)', provider: BYOKProvider.MOONSHOT, expected: true },
        { name: 'zai (GLM)', provider: BYOKProvider.ZAI, expected: true },
        { name: 'bedrock + Claude', provider: BYOKProvider.AMAZON_BEDROCK, model: 'anthropic.claude-sonnet-4-5', expected: true },
        { name: 'bedrock + Nova', provider: BYOKProvider.AMAZON_BEDROCK, model: 'amazon.nova-pro', expected: false },
        { name: 'vertex + Claude', provider: BYOKProvider.GOOGLE_VERTEX, model: 'claude-sonnet-4-5', expected: true },
        { name: 'vertex + Gemini', provider: BYOKProvider.GOOGLE_VERTEX, model: 'gemini-2.5-flash', expected: false },
        { name: 'openai', provider: BYOKProvider.OPENAI, expected: false },
        { name: 'google_gemini', provider: BYOKProvider.GOOGLE_GEMINI, expected: false },
        { name: 'novita', provider: BYOKProvider.NOVITA, expected: false },
        { name: 'undefined provider', provider: undefined, expected: false },
    ];

    it.each(cases)('$name → $expected', ({ provider, model, expected }) => {
        expect(structuredOutputForcesToolChoice(provider, model)).toBe(expected);
    });

    // STRUCTURAL completeness: lock the EXACT set of registered providers that
    // force tool_choice (model-agnostic, i.e. a non-Claude model). If a new
    // provider is added to the registry — or an existing one is mis-classified —
    // this fails, forcing a deliberate decision instead of a silent miss.
    // Bedrock/Vertex are model-dependent (Claude only) → NOT in this set with a
    // neutral model; their Claude case is covered above.
    it('locks the model-agnostic set of tool_choice-forcing providers (registry-wide)', () => {
        const { REGISTRY } = require('@libs/llm/providers');
        const forcing = REGISTRY.ids().filter((id: string) =>
            structuredOutputForcesToolChoice(id, 'gpt-4o'),
        );
        expect(new Set(forcing)).toEqual(
            new Set(['anthropic', 'anthropic_compatible', 'moonshot', 'zai']),
        );
    });

    it('never throws for any registered provider (all ids classify cleanly)', () => {
        const { REGISTRY } = require('@libs/llm/providers');
        for (const id of REGISTRY.ids()) {
            expect(() =>
                structuredOutputForcesToolChoice(id, 'x'),
            ).not.toThrow();
        }
    });
});

describe('buildReasoningProviderOptions', () => {
    describe('returns {} when reasoning is off or provider is missing', () => {
        const cases: Array<{
            name: string;
            provider?: BYOKProvider | string;
            effort?: ReasoningEffort;
            modelName?: string;
        }> = [
            { name: 'effort=undefined', provider: BYOKProvider.ANTHROPIC },
            { name: 'effort=none', provider: BYOKProvider.ANTHROPIC, effort: 'none' },
            { name: 'provider=undefined', effort: 'high' },
            { name: 'provider=empty string', provider: '', effort: 'high' },
        ];

        it.each(cases)('$name → {}', ({ provider, effort, modelName }) => {
            expect(
                buildReasoningProviderOptions(provider, effort, modelName),
            ).toEqual({});
        });
    });

    describe('Anthropic', () => {
        it('uses adaptive thinking + effort for opus-4-7 (4.7+)', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'high',
                    'claude-opus-4-7',
                ),
            ).toEqual({
                anthropic: {
                    thinking: { type: 'adaptive' },
                    effort: 'high',
                },
            });
        });

        it('uses adaptive thinking + effort for sonnet-4-6 (4.6+)', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'medium',
                    'claude-sonnet-4-6-20250929',
                ),
            ).toEqual({
                anthropic: {
                    thinking: { type: 'adaptive' },
                    effort: 'medium',
                },
            });
        });

        it('falls back to budgetTokens for sonnet-4-5 (pre-4.6)', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'high',
                    'claude-sonnet-4-5-20250929',
                ),
            ).toEqual({
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET.high,
                    },
                },
            });
        });

        it('falls back to budgetTokens for opus-4-1 (pre-4.6)', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'medium',
                    'claude-opus-4-1-20250805',
                ),
            ).toEqual({
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET.medium,
                    },
                },
            });
        });

        it('falls back to budgetTokens for older models (sonnet-3.7)', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'high',
                    'claude-3-7-sonnet-20250219',
                ),
            ).toEqual({
                anthropic: {
                    thinking: {
                        type: 'enabled',
                        budgetTokens: EFFORT_TO_BUDGET.high,
                    },
                },
            });
        });

        it.each([
            ['claude-opus-5'],
            ['claude-sonnet-5'],
            ['claude-opus-4-8'],
            ['anthropic:claude-opus-5'],
            ['anthropic.claude-opus-5'],
            ['claude-opus-4-8@20260101'],
        ])('uses adaptive thinking for %s (4.7+ rejects budgetTokens)', (model) => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'high',
                    model,
                ),
            ).toEqual({
                anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
            });
        });

        it('omits thinking config when the model cannot be identified', () => {
            // Previously this fell through to budgetTokens. That shape is a hard
            // 400 on every Claude from 4.7 on, which kills the whole review —
            // whereas omitting only costs thinking depth. The old failure mode
            // was reachable in production: the code-review loop never passed a
            // modelName at all.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'low',
                    undefined,
                ),
            ).toEqual({});

            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.ANTHROPIC,
                    'low',
                    'kodus-generalist-review-agent',
                ),
            ).toEqual({});
        });

        describe('effort=none', () => {
            it('disables thinking explicitly on models that think by default', () => {
                // Opus 5 / Sonnet 5 think unless told not to, so omitting the
                // config would bill thinking to a user who picked Off.
                expect(
                    buildReasoningProviderOptions(
                        BYOKProvider.ANTHROPIC,
                        'none',
                        'claude-opus-5',
                    ),
                ).toEqual({
                    anthropic: { thinking: { type: 'disabled' } },
                });
            });

            it('leaves Fable thinking on — the API rejects disabled', () => {
                expect(
                    buildReasoningProviderOptions(
                        BYOKProvider.ANTHROPIC,
                        'none',
                        'claude-fable-5',
                    ),
                ).toEqual({});
            });

            it('omits the config on legacy models, which never think unasked', () => {
                expect(
                    buildReasoningProviderOptions(
                        BYOKProvider.ANTHROPIC,
                        'none',
                        'claude-sonnet-4-5-20250929',
                    ),
                ).toEqual({});
            });
        });
    });

    describe('Google Gemini', () => {
        it('uses thinkingLevel for Gemini 3+ (gemini-3.1-pro-preview)', () => {
            // This is THE regression we just shipped. Old code passed agentName,
            // detection failed, fell through to thinkingBudget. Now we pass modelId.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'high',
                    'gemini-3.1-pro-preview',
                ),
            ).toEqual({
                google: {
                    thinkingConfig: { thinkingLevel: 'high' },
                },
            });
        });

        it('uses thinkingLevel for any model containing "gemini-3"', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'low',
                    'gemini-3-flash',
                ),
            ).toEqual({
                google: {
                    thinkingConfig: { thinkingLevel: 'low' },
                },
            });
        });

        it('uses thinkingBudget for Gemini 2.5', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'high',
                    'gemini-2.5-pro',
                ),
            ).toEqual({
                google: {
                    thinkingConfig: { thinkingBudget: EFFORT_TO_BUDGET.high },
                },
            });
        });

        it('uses thinkingBudget for medium effort on Gemini 2.5', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'medium',
                    'gemini-2.5-flash',
                ),
            ).toEqual({
                google: {
                    thinkingConfig: { thinkingBudget: EFFORT_TO_BUDGET.medium },
                },
            });
        });

        it('treats GOOGLE_VERTEX same as GOOGLE_GEMINI', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_VERTEX,
                    'high',
                    'gemini-3.1-pro-preview',
                ),
            ).toEqual({
                google: {
                    thinkingConfig: { thinkingLevel: 'high' },
                },
            });
        });
    });

    describe('OpenAI', () => {
        it('emits reasoningEffort under openai key for o-series', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI,
                    'high',
                    'o3-mini',
                ),
            ).toEqual({
                openai: { reasoningEffort: 'high' },
            });
        });

        it('emits reasoningEffort=low under openai key', () => {
            expect(
                buildReasoningProviderOptions(BYOKProvider.OPENAI, 'low'),
            ).toEqual({
                openai: { reasoningEffort: 'low' },
            });
        });
    });

    describe('OpenRouter', () => {
        it('emits reasoning.effort under openrouter key', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPEN_ROUTER,
                    'medium',
                ),
            ).toEqual({
                openrouter: { reasoning: { effort: 'medium' } },
            });
        });
    });

    describe('OpenAI-Compatible', () => {
        it('emits thinking.type=enabled (effort ignored)', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'high',
                ),
            ).toEqual({
                openaiCompatible: { thinking: { type: 'enabled' } },
            });
        });
    });

    describe('Unknown providers', () => {
        it('returns {} for NOVITA (no thinking mapping yet)', () => {
            expect(
                buildReasoningProviderOptions(BYOKProvider.NOVITA, 'high'),
            ).toEqual({});
        });

        it('returns {} for unknown string provider', () => {
            expect(
                buildReasoningProviderOptions('madeup-provider', 'high'),
            ).toEqual({});
        });
    });
});

describe('buildProviderOptions', () => {
    it('returns {} when no reasoning config is provided', () => {
        const result = buildProviderOptions('my-run', {
            organizationId: 'org-1',
            teamId: 'team-1',
        });
        expect(result).toEqual({});
    });

    it('includes reasoning when effort + provider + model are provided', () => {
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: BYOKProvider.GOOGLE_GEMINI,
            reasoningEffort: 'high',
            modelName: 'gemini-3.1-pro-preview',
        });
        expect(result.google).toEqual({
            thinkingConfig: { thinkingLevel: 'high' },
        });
    });

    it('omits provider-specific reasoning when effort is none', () => {
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: BYOKProvider.GOOGLE_GEMINI,
            reasoningEffort: 'none',
            modelName: 'gemini-3.1-pro-preview',
        });
        expect(result.google).toBeUndefined();
        expect(result.anthropic).toBeUndefined();
        expect(result.openai).toBeUndefined();
    });

    it('JSON override takes precedence over effort preset', () => {
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: BYOKProvider.ANTHROPIC,
            reasoningEffort: 'high',
            modelName: 'claude-sonnet-4-5-20250929',
            reasoningConfigOverride: JSON.stringify({
                anthropic: { thinking: { type: 'enabled', budgetTokens: 999 } },
            }),
        });
        expect(result.anthropic).toEqual({
            thinking: { type: 'enabled', budgetTokens: 999 },
        });
        // Override replaces the preset entirely
        expect(result.anthropic.outputConfig).toBeUndefined();
    });

    it('falls back to effort preset when override JSON is invalid', () => {
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: BYOKProvider.GOOGLE_GEMINI,
            reasoningEffort: 'high',
            modelName: 'gemini-3.1-pro-preview',
            reasoningConfigOverride: 'not-valid-json{{',
        });
        expect(result.google).toEqual({
            thinkingConfig: { thinkingLevel: 'high' },
        });
    });

    it('auto-wraps a flat override under the provider namespace from the registry', () => {
        // openai_compatible → 'openaiCompatible' namespace (declared by the
        // openai module, resolved via REGISTRY — no hand-kept map).
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: 'openai_compatible',
            modelName: 'kimi-k2',
            reasoningConfigOverride: JSON.stringify({
                thinking: { type: 'enabled' },
            }),
        });
        expect(result.openaiCompatible).toEqual({
            thinking: { type: 'enabled' },
        });
    });

    it('auto-wraps a flat override under anthropic', () => {
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: BYOKProvider.ANTHROPIC,
            modelName: 'claude-opus-5',
            reasoningConfigOverride: JSON.stringify({
                thinking: { type: 'disabled' },
            }),
        });
        expect(result.anthropic).toEqual({ thinking: { type: 'disabled' } });
    });

    it('passes a flat override through unwrapped for a provider with no namespace', () => {
        // azure/bedrock declare no namespace → unwrapped (preserved).
        const result = buildProviderOptions('main-loop', undefined, {
            byokProvider: 'azure',
            modelName: 'gpt-4o',
            reasoningConfigOverride: JSON.stringify({ foo: 'bar' }),
        });
        expect(result).toEqual({ foo: 'bar' });
    });

    it('wraps a flat override under anthropic for the Anthropic-protocol brands', () => {
        // Moonshot/Kimi and Z.ai/GLM are first-class brands that speak the
        // Anthropic protocol → their override lands under the `anthropic` namespace.
        for (const brand of ['moonshot', 'zai']) {
            const result = buildProviderOptions('main-loop', undefined, {
                byokProvider: brand,
                modelName: brand === 'moonshot' ? 'kimi-k2.7-code' : 'glm-5.2',
                reasoningConfigOverride: JSON.stringify({ foo: 'bar' }),
            });
            expect(result.anthropic).toEqual({ foo: 'bar' });
        }
    });
});

describe('buildLangfuseTelemetry', () => {
    const originalEnv = { ...process.env };
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it('returns isEnabled=false when LANGFUSE_TRACING is not true', () => {
        delete process.env.LANGFUSE_TRACING;
         
        const { buildLangfuseTelemetry } = require('@libs/core/log/langfuse');
        const result = buildLangfuseTelemetry('my-run');
        expect(result.isEnabled).toBe(false);
        expect(result.functionId).toBe('my-run');
    });

    it('returns isEnabled=true when tracing env is fully configured', () => {
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
        jest.resetModules();
         
        const { buildLangfuseTelemetry } = require('@libs/core/log/langfuse');
        const result = buildLangfuseTelemetry('my-run', {
            organizationId: 'org-1',
            teamId: 'team-1',
            pullRequestId: 42,
        });
        expect(result.isEnabled).toBe(true);
        expect(result.functionId).toBe('my-run');
        expect(result.metadata).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-1',
            pullRequestId: 42,
        });
    });

    it('omits metadata key when no metadata object is passed', () => {
         
        const { buildLangfuseTelemetry } = require('@libs/core/log/langfuse');
        const result = buildLangfuseTelemetry('my-run');
        expect(result.metadata).toBeUndefined();
    });

    it('toAiSdkTelemetryArgs maps metadata into runtimeContext', () => {
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
        jest.resetModules();
         
        const {
            buildLangfuseTelemetry,
            toAiSdkTelemetryArgs,
        } = require('@libs/core/log/langfuse');
        const args = toAiSdkTelemetryArgs(
            buildLangfuseTelemetry('my-run', {
                organizationId: 'org-1',
                teamId: 'team-1',
            }),
        );
        expect(args.telemetry.functionId).toBe('my-run');
        expect(args.telemetry.includeRuntimeContext).toEqual({
            organizationId: true,
            teamId: true,
        });
        expect(args.runtimeContext).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
    });
});
