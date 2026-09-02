import { BYOKProvider } from '@libs/llm/model-providers';

import {
    buildProviderOptions,
    buildReasoningProviderOptions,
    defaultReasoningEffortFor,
    EFFORT_TO_BUDGET,
    type ReasoningEffort,
} from '@libs/llm/reasoning-options';
import type { NormalizedModel } from '@libs/llm/byok-config';

describe('defaultReasoningEffortFor — family-driven default (env + BYOK)', () => {
    const anthropic = (model: string): NormalizedModel =>
        ({ provider: BYOKProvider.ANTHROPIC, apiKey: '', model }) as any;

    it("gives 'medium' to a thinks-by-default Claude (opus-5) — the env goal", () => {
        // claude-opus-5 is adaptive → reasoningTraits.thinksByDefault=true, matched
        // by FAMILY pattern (no per-model entry), so a brand-new Opus inherits it.
        expect(defaultReasoningEffortFor(anthropic('claude-opus-5'))).toBe(
            'medium',
        );
        expect(defaultReasoningEffortFor(anthropic('claude-opus-4-7'))).toBe(
            'medium',
        );
    });

    it('leaves a NON-thinks-by-default model unset (falls to caller default)', () => {
        // Budget-generation Claude (4.1) reasons only when asked → not
        // thinks-by-default → resolver returns undefined, caller policy decides.
        expect(
            defaultReasoningEffortFor(anthropic('claude-opus-4-1')),
        ).toBeUndefined();
    });

    it('returns undefined for an absent/unknown slot (safe, never throws)', () => {
        expect(defaultReasoningEffortFor(undefined)).toBeUndefined();
        expect(
            defaultReasoningEffortFor({ provider: 'nope', model: 'x' } as any),
        ).toBeUndefined();
    });
});

// The tool_choice-forcing classification + registry-wide lock moved to the
// trait model: see providers/thinking-forced-toolchoice.contract.spec.ts
// (planStructuredCall over capabilities().structuredOutput + reasoningTraits).

describe('buildReasoningProviderOptions', () => {
    describe('returns {} when reasoning is off or provider is missing', () => {
        const cases: Array<{
            name: string;
            provider?: BYOKProvider | string;
            effort?: ReasoningEffort;
            modelName?: string;
        }> = [
            { name: 'effort=undefined', provider: BYOKProvider.ANTHROPIC },
            {
                name: 'effort=none',
                provider: BYOKProvider.ANTHROPIC,
                effort: 'none',
            },
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
        ])(
            'uses adaptive thinking for %s (4.7+ rejects budgetTokens)',
            (model) => {
                expect(
                    buildReasoningProviderOptions(
                        BYOKProvider.ANTHROPIC,
                        'high',
                        model,
                    ),
                ).toEqual({
                    anthropic: {
                        thinking: { type: 'adaptive' },
                        effort: 'high',
                    },
                });
            },
        );

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

        it('uses thinkingBudget for Gemini 2.5, CLAMPED to the model ceiling', () => {
            // Google documents gemini-2.5-pro's budget range as 128-32,768 and
            // rejects a request outside it. Our shared EFFORT_TO_BUDGET.high is
            // 40,000, which overshot EVERY model in the 2.5 line (Pro 32,768;
            // Flash and Flash-Lite 24,576) - so the effort table cannot be sent
            // raw, it has to be clamped by the model's own reasoning config.
            expect(EFFORT_TO_BUDGET.high).toBeGreaterThan(32_768);
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'high',
                    'gemini-2.5-pro',
                ),
            ).toEqual({
                google: { thinkingConfig: { thinkingBudget: 32_768 } },
            });
        });

        it('clamps to the LOWER Flash ceiling on the same effort', () => {
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'high',
                    'gemini-2.5-flash',
                ),
            ).toEqual({
                google: { thinkingConfig: { thinkingBudget: 24_576 } },
            });
        });

        it('sends NO thinkingConfig to a Gemini with no thinking support', () => {
            // Plain gemini-2.0-flash predates thinking and appears in no
            // supported list; the field is unsupported there, not a no-op.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'medium',
                    'gemini-2.0-flash',
                ),
            ).toEqual({});
        });

        it('rounds a level UP when the model does not accept it', () => {
            // gemini-3-pro-preview takes low and high ONLY - "medium" is invalid.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.GOOGLE_GEMINI,
                    'medium',
                    'gemini-3-pro-preview',
                ),
            ).toEqual({
                google: { thinkingConfig: { thinkingLevel: 'high' } },
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
        // The reasoning PARAMETER is a per-model fact; the transport the user
        // chose is honored either way. Emitting one blanket shape meant a user on
        // NVIDIA NIM / MiniMax / an OpenAI proxy who picked High got a body field
        // their server does not implement — and no reasoning at all.
        it('DeepSeek takes the toggle AND an effort, on its own scale', () => {
            // api-docs.deepseek.com: both are sent together, and the scale is
            // low/high/max — "medium" is not an accepted value there, so our
            // top effort maps to `max`.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'high',
                    'deepseek-v4-flash',
                ),
            ).toEqual({
                openaiCompatible: {
                    thinking: { type: 'enabled' },
                    reasoningEffort: 'max',
                },
            });
        });

        it('Kimi takes the toggle ALONE — Moonshot rejects the pair', () => {
            // "cannot specify both 'thinking' and 'reasoning_effort'" — so Kimi's
            // granularity genuinely stops at the toggle (HKUDS/nanobot#3939).
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'high',
                    'kimi-k2.6',
                ),
            ).toEqual({
                openaiCompatible: { thinking: { type: 'enabled' } },
            });
        });

        it('GLM takes both, and MEDIUM folds into the brand\'s "high"', () => {
            // docs.z.ai: the scale is low/high/max with no "medium" — GLM-5.2
            // folds low/medium into high itself, so emitting our own word would
            // be shipping a value the API does not define.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'medium',
                    'glm-5.2',
                ),
            ).toEqual({
                openaiCompatible: {
                    thinking: { type: 'enabled' },
                    reasoningEffort: 'high',
                },
            });
        });

        it('turning reasoning OFF is said out loud on GLM and DeepSeek too', () => {
            // Previously gated on the Kimi family alone, so a user who picked Off
            // on GLM or DeepSeek kept paying for thinking.
            for (const model of ['glm-5.2', 'deepseek-v4-pro', 'kimi-k2.6']) {
                expect(
                    buildReasoningProviderOptions(
                        BYOKProvider.OPENAI_COMPATIBLE,
                        'none',
                        model,
                    ),
                ).toEqual({
                    openaiCompatible: { thinking: { type: 'disabled' } },
                });
            }
        });

        it('never sends a disable to an always-thinking variant', () => {
            // k3 / k2.7-code / GLM-5.3 expose no off switch and reject the field.
            for (const model of ['k3', 'kimi-k2.7-code', 'glm-5.3']) {
                expect(
                    buildReasoningProviderOptions(
                        BYOKProvider.OPENAI_COMPATIBLE,
                        'none',
                        model,
                    ),
                ).toEqual({});
            }
        });

        it('emits reasoningEffort for a native-OpenAI id served over a proxy', () => {
            // camelCase on purpose: it is the SDK's own option name, which the SDK
            // renders as the `reasoning_effort` body field. A snake_case key is
            // spread in first and then overwritten with undefined.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'high',
                    'gpt-5.6-sol',
                ),
            ).toEqual({ openaiCompatible: { reasoningEffort: 'high' } });
        });

        it('emits NOTHING for an upstream it cannot identify', () => {
            // A strict server 400s on an unknown body field; a lenient one ignores
            // it. Either way, inventing a param is worse than saying nothing.
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'high',
                    'nemotron-3-ultra-550b-a55b',
                ),
            ).toEqual({});
            expect(
                buildReasoningProviderOptions(
                    BYOKProvider.OPENAI_COMPATIBLE,
                    'high',
                ),
            ).toEqual({});
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

    it('wraps a flat override for azure and bedrock, which used to drop it', () => {
        // This test used to assert the opposite, with the reason written in:
        // "azure/bedrock declare no namespace → unwrapped (preserved)".
        // "Preserved" was wrong — an unwrapped override reaches the SDK under no
        // key at all and is discarded without a word. Both modules now declare
        // the namespace their built model actually reads.
        expect(
            buildProviderOptions('main-loop', undefined, {
                byokProvider: 'azure',
                modelName: 'gpt-4o',
                reasoningConfigOverride: JSON.stringify({ foo: 'bar' }),
            }),
        ).toEqual({ azure: { foo: 'bar' } });

        expect(
            buildProviderOptions('main-loop', undefined, {
                byokProvider: 'amazon_bedrock',
                modelName: 'anthropic.claude-sonnet-4-6',
                reasoningConfigOverride: JSON.stringify({ foo: 'bar' }),
            }),
        // ...and then asserted the NEXT wrong key. `amazon-bedrock` is the built
        // model's provider ID, not the providerOptions key: the SDK parses only
        // `amazonBedrock` or its legacy `bedrock` alias. This spec agreeing with
        // the module proved nothing, because both were reading the same wrong
        // property — which is why the claim is now also made on the wire, in
        // byok-config-matrix, where the request body can contradict it.
        ).toEqual({ amazonBedrock: { foo: 'bar' } });
    });

    it('leaves an override alone when it uses an SDK alias key', () => {
        // The vendor's docs show `{ bedrock: ... }`, so that is what gets pasted.
        // Wrapping it under the canonical namespace would bury a key the SDK
        // reads inside one it also reads, and the inner object is not a valid
        // option — a correct paste turned into a silent no-op.
        expect(
            buildProviderOptions('main-loop', undefined, {
                byokProvider: 'amazon_bedrock',
                modelName: 'anthropic.claude-sonnet-4-6',
                reasoningConfigOverride: JSON.stringify({
                    bedrock: { reasoningConfig: { type: 'enabled' } },
                }),
            }),
        ).toEqual({ bedrock: { reasoningConfig: { type: 'enabled' } } });
    });

    it('wraps a Vertex override by MODEL, because one id builds two SDK models', () => {
        // Gemini-on-Vertex is `google.vertex.chat` (reads `google`);
        // Claude-on-Vertex is an Anthropic language model (reads `anthropic`).
        // Answering `google` for both put a Claude user's override under a key
        // nothing reads.
        expect(
            buildProviderOptions('main-loop', undefined, {
                byokProvider: 'google_vertex',
                modelName: 'gemini-3.7-flash',
                reasoningConfigOverride: JSON.stringify({ foo: 'bar' }),
            }),
        ).toEqual({ google: { foo: 'bar' } });

        expect(
            buildProviderOptions('main-loop', undefined, {
                byokProvider: 'google_vertex',
                modelName: 'claude-opus-4-7',
                reasoningConfigOverride: JSON.stringify({ foo: 'bar' }),
            }),
        ).toEqual({ anthropic: { foo: 'bar' } });
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

describe('mutation-killing: OpenRouter routing merge + boundary guards', () => {
    describe('defaultReasoningEffortFor — guard boundaries', () => {
        it('returns undefined when provider is set but model is missing', () => {
            // Kills a mutant that drops the `!slot?.model` half of the guard:
            // a slot with a real provider but no model must still bail out.
            expect(
                defaultReasoningEffortFor({
                    provider: BYOKProvider.ANTHROPIC,
                    apiKey: '',
                } as any),
            ).toBeUndefined();
            expect(
                defaultReasoningEffortFor({
                    provider: BYOKProvider.ANTHROPIC,
                    model: '',
                    apiKey: '',
                } as any),
            ).toBeUndefined();
        });

        it('returns undefined when model is set but provider is missing', () => {
            expect(
                defaultReasoningEffortFor({ model: 'claude-opus-5' } as any),
            ).toBeUndefined();
        });
    });

    describe('buildProviderOptions — OpenRouter provider pinning', () => {
        it('merges reasoning.effort and provider.order under one openrouter key', () => {
            // The deep-merge in mergeOpenRouterOptions must keep BOTH the
            // reasoning payload (base.openrouter) and the routing payload
            // (routing.openrouter). A shallow overwrite would drop reasoning.
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'medium',
                openrouterProviderOrder: ['openai', 'anthropic'],
            });
            expect(result).toEqual({
                openrouter: {
                    reasoning: { effort: 'medium' },
                    provider: { order: ['openai', 'anthropic'] },
                },
            });
        });

        it('filters empty/whitespace provider ids and preserves exact order', () => {
            // Kills mutants on the order filter (predicate flip, dropped trim
            // check) and on array ordering.
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'low',
                openrouterProviderOrder: ['', '   ', 'groq', 'openai'],
            });
            expect(result.openrouter.provider).toEqual({
                order: ['groq', 'openai'],
            });
        });

        it('emits allow_fallbacks=false (boolean check, not truthiness)', () => {
            // typeof === 'boolean' must let `false` through; a truthiness guard
            // would silently drop the user's explicit opt-out.
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'low',
                openrouterAllowFallbacks: false,
            });
            expect(result).toEqual({
                openrouter: {
                    reasoning: { effort: 'low' },
                    provider: { allow_fallbacks: false },
                },
            });
        });

        it('emits allow_fallbacks=true alongside order when both are set', () => {
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'high',
                openrouterProviderOrder: ['deepinfra'],
                openrouterAllowFallbacks: true,
            });
            expect(result).toEqual({
                openrouter: {
                    reasoning: { effort: 'high' },
                    provider: {
                        order: ['deepinfra'],
                        allow_fallbacks: true,
                    },
                },
            });
        });

        it('omits the provider payload when order is all-empty and no fallbacks flag', () => {
            // hasOrder=false && hasFallbacksOverride=false → routing {}; only the
            // reasoning payload survives (no empty provider key leaks through).
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'medium',
                openrouterProviderOrder: ['', '  '],
            });
            expect(result).toEqual({
                openrouter: { reasoning: { effort: 'medium' } },
            });
            expect(result.openrouter.provider).toBeUndefined();
        });

        it('emits routing with no reasoning when effort is none', () => {
            // effort=none → reasoning {}; routing still applies → openrouter has
            // only provider, no reasoning key.
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'none',
                openrouterProviderOrder: ['groq'],
            });
            expect(result).toEqual({
                openrouter: { provider: { order: ['groq'] } },
            });
            expect(result.openrouter.reasoning).toBeUndefined();
        });

        it('ignores OpenRouter routing fields for a non-OpenRouter provider', () => {
            // The byokProvider !== OPEN_ROUTER guard must suppress routing even
            // when order/fallbacks are supplied.
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.ANTHROPIC,
                reasoningEffort: 'high',
                modelName: 'claude-opus-5',
                openrouterProviderOrder: ['openai'],
                openrouterAllowFallbacks: false,
            });
            expect(result.openrouter).toBeUndefined();
            expect(result).toEqual({
                anthropic: {
                    thinking: { type: 'adaptive' },
                    effort: 'high',
                },
            });
        });

        it('layers OpenRouter routing onto the JSON override path', () => {
            // The override branch spreads buildOpenRouterRouting first; an
            // override that lands under a DIFFERENT namespace than openrouter
            // leaves the routing openrouter key intact.
            const result = buildProviderOptions('run', undefined, {
                byokProvider: BYOKProvider.OPEN_ROUTER,
                reasoningEffort: 'high',
                openrouterProviderOrder: ['openai'],
                reasoningConfigOverride: JSON.stringify({
                    anthropic: { thinking: { type: 'disabled' } },
                }),
            });
            expect(result).toEqual({
                openrouter: { provider: { order: ['openai'] } },
                anthropic: { thinking: { type: 'disabled' } },
            });
        });
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
