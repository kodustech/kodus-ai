/**
 * Focused parity spec for the SafeguardPipelineService migration onto
 * runStructuredReviewCall (REQ-NOLC-01). Both structured call-sites (feature
 * extraction, prompt-only verification) and the multi-turn agent loop were moved
 * off the legacy LangChain PromptRunner onto the AI SDK path. These tests
 * pin that the safeguard VERDICT — which suggestions survive triage +
 * verification, and how improvedCode is nulled — is unchanged for representative
 * inputs. They mock the tracedGenerateText seam (like structured-review-call.spec.ts),
 * NOT the LangChain builder that no longer exists on this path.
 */

// --- runStructuredReviewCall seam mocks (mirror structured-review-call.spec.ts) ---
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: true })),
    getModelName: jest.fn(() => 'test-model'),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({ telemetry: { isEnabled: false } })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import { tracedGenerateText } from '@libs/llm/llm-call';
import { SafeguardFeatureSet } from '@libs/common/utils/prompts/codeReviewSafeguardFeatures';

import { SafeguardPipelineService } from './safeguardPipeline.service';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

/** Return the AI-SDK structured-call shape runStructuredReviewCall unwraps. */
const out = (obj: any) => ({ experimental_output: obj, usage: {} });

/** All 13 safeguard features default false; override the ones under test. */
const mkFeatures = (
    overrides: Partial<SafeguardFeatureSet>,
): SafeguardFeatureSet => ({
    has_resource_leak: false,
    has_inconsistent_contract: false,
    has_wrong_algorithm: false,
    has_data_exposure: false,
    has_missing_error_handling: false,
    has_redundant_work_in_loop: false,
    has_unsafe_data_flow: false,
    requires_assumed_input: false,
    requires_assumed_workload: false,
    is_quality_opinion: false,
    is_anti_pattern_only: false,
    targets_unchanged_code: false,
    improvedCode_is_correct: true,
    ...overrides,
});

const baseParams = (suggestions: any[], extra: Record<string, any> = {}) => ({
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    prNumber: 7,
    file: { filename: 'f.ts', fileContent: 'content' },
    relevantContent: 'content',
    codeDiff: '+ x',
    suggestions,
    languageResultPrompt: 'en-US',
    reviewMode: 'light_mode',
    // A BYOK config keeps runStructuredReviewCall on the main model (no managed
    // Groq trial fallback), so a single mocked resolve per call is deterministic.
    byokConfig: { main: { provider: 'openai', model: 'gpt-4o' } },
    ...extra,
});

describe('SafeguardPipelineService — structured-call parity', () => {
    let service: SafeguardPipelineService;
    let observability: any;

    beforeEach(() => {
        mockGenerate.mockReset();
        observability = {
            // runStructuredReviewCall runs its exec inside runAiSdkLLMInSpan and
            // reads experimental_output off the result.
            runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
            runLLMInSpan: jest.fn(),
        };
        service = new SafeguardPipelineService(
            observability,
            {} as any, // sandboxProvider
            {} as any, // documentationSearchExaService
        );
    });

    it('prompt-only path: discards quality-opinion in triage, keeps/drops structural defects by the verdict, and nulls incorrect improvedCode', async () => {
        const suggestions = [
            { id: 's1', suggestionContent: 'c1', improvedCode: 'orig1' },
            { id: 's2', suggestionContent: 'c2', improvedCode: 'orig2' },
            { id: 's3', suggestionContent: 'c3', improvedCode: 'orig3' },
            { id: 's4', suggestionContent: 'c4', improvedCode: 'orig4' },
        ];

        mockGenerate
            // 1) feature extraction — one call for all suggestions
            .mockResolvedValueOnce(
                out({
                    codeSuggestions: [
                        {
                            id: 's1',
                            features: mkFeatures({ is_quality_opinion: true }),
                        },
                        {
                            id: 's2',
                            features: mkFeatures({ has_resource_leak: true }),
                        },
                        {
                            id: 's3',
                            features: mkFeatures({ has_resource_leak: true }),
                        },
                        {
                            id: 's4',
                            features: mkFeatures({
                                has_resource_leak: true,
                                improvedCode_is_correct: false,
                            }),
                        },
                    ],
                }),
            )
            // 2) prompt-only verify s2 → keep
            .mockResolvedValueOnce(out({ verdict: true, evidence: 'real leak' }))
            // 3) prompt-only verify s3 → discard
            .mockResolvedValueOnce(out({ verdict: false, evidence: 'refuted' }))
            // 4) prompt-only verify s4 → keep (but improvedCode is wrong → null)
            .mockResolvedValueOnce(out({ verdict: true, evidence: 'real leak' }));

        // No remoteCommands → prompt-only verification path.
        const result = await service.execute(baseParams(suggestions) as any);

        expect(result.suggestions).toEqual([
            { id: 's2', suggestionContent: 'c2', improvedCode: 'orig2' },
            { id: 's4', suggestionContent: 'c4', improvedCode: null },
        ]);
        // One extraction + one verify per to-verify suggestion (s2, s3, s4).
        expect(mockGenerate).toHaveBeenCalledTimes(4);
        // Single-span AI SDK path — the legacy runLLMInSpan wrapper is gone (Q4).
        expect(observability.runLLMInSpan).not.toHaveBeenCalled();
    });

    it('agent path: flattened multi-turn loop keeps a suggestion the agent verifies as a real defect', async () => {
        const suggestions = [
            { id: 's1', suggestionContent: 'leak', improvedCode: 'orig1' },
        ];

        const remoteCommands = {
            grep: jest.fn().mockResolvedValue('match line'),
            read: jest.fn().mockResolvedValue('file body'),
            listDir: jest.fn().mockResolvedValue('dir listing'),
        };

        mockGenerate
            // 1) feature extraction → structural defect → triage 'verify'
            .mockResolvedValueOnce(
                out({
                    codeSuggestions: [
                        {
                            id: 's1',
                            features: mkFeatures({ has_resource_leak: true }),
                        },
                    ],
                }),
            )
            // 2) agent turn 0 — must make a tool call before any verdict
            .mockResolvedValueOnce(out({ tool: 'read', path: 'f.ts' }))
            // 3) agent turn 1 — verdict keep
            .mockResolvedValueOnce(
                out({
                    verdict: true,
                    action: 'no_changes',
                    evidence: 'confirmed real leak',
                }),
            );

        const result = await service.execute(
            baseParams(suggestions, { remoteCommands }) as any,
        );

        expect(result.suggestions).toEqual([
            { id: 's1', suggestionContent: 'leak', improvedCode: 'orig1' },
        ]);
        // The agent read the file exactly once (turn-0 tool call executed).
        expect(remoteCommands.read).toHaveBeenCalledTimes(1);
        // extraction + turn0 tool call + turn1 verdict.
        expect(mockGenerate).toHaveBeenCalledTimes(3);
    });

    it('feature extraction failure keeps all suggestions (safe default)', async () => {
        const suggestions = [
            { id: 's1', suggestionContent: 'c1' },
            { id: 's2', suggestionContent: 'c2' },
        ];

        // Every attempt fails → runStructuredReviewCall throws → extractFeatures
        // returns no features → the pipeline returns the input untouched.
        mockGenerate.mockRejectedValue(new Error('provider down'));

        const result = await service.execute(baseParams(suggestions) as any);

        expect(result.suggestions).toEqual(suggestions);
    });
});

/**
 * CONTRACT tests for the three LLM.run boundaries in this service (issue #1786).
 *
 * The bug class: a non-strict model (kimi/glm/deepseek/z-ai on the json_object
 * fallback) returns JSON in the WRONG envelope — a bare array, a `{result:...}`
 * wrapper, a stringified payload, right-data-under-wrong-keys, `null`, `{}`, or a
 * partial object — and the deterministic layer around the call SILENTLY degrades.
 *
 * These mock the SAME seam the parity suite uses (`tracedGenerateText`). Crucially
 * `readOutput` reads `experimental_output` WITHOUT re-validating it (the AI SDK's
 * schema check runs inside the real `generateText`, which is mocked away here), so
 * an off-schema shape flows straight to the deterministic layer — exactly what a
 * json_object-fallback model produces on the wire. That makes this the right place
 * to prove the code does not quietly drop/keep-all on a shape it cannot read.
 *
 * Layers per boundary: HAPPY (exact side effect) · OFF-SCHEMA (#1786 robustness,
 * with `it.failing` where the code currently degrades) · FAIL-SAFE (provider error
 * → documented fallback, never throws past the boundary). Every layer also asserts
 * the method returns its declared shape.
 */
describe('SafeguardPipelineService — LLM.run boundary contract (#1786 off-schema)', () => {
    let service: SafeguardPipelineService;
    let observability: any;

    beforeEach(() => {
        mockGenerate.mockReset();
        observability = {
            runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
            runLLMInSpan: jest.fn(),
        };
        service = new SafeguardPipelineService(
            observability,
            {} as any,
            {} as any,
        );
    });

    // ---------------------------------------------------------------- Layer 1
    describe('Layer 1 — HAPPY PATH (exact side effect + declared shape)', () => {
        it('drives triage from the extracted features and returns exactly ISafeguardResponse', async () => {
            const suggestions = [
                { id: 'q', suggestionContent: 'style nit', improvedCode: 'a' }, // quality_opinion → discard
                { id: 'k', suggestionContent: 'real leak', improvedCode: 'b' }, // structural → verify → keep
            ];

            mockGenerate
                .mockResolvedValueOnce(
                    out({
                        codeSuggestions: [
                            {
                                id: 'q',
                                features: mkFeatures({
                                    is_quality_opinion: true,
                                }),
                            },
                            {
                                id: 'k',
                                features: mkFeatures({
                                    has_missing_error_handling: true,
                                }),
                            },
                        ],
                    }),
                )
                // prompt-only verify of 'k' → keep
                .mockResolvedValueOnce(
                    out({ verdict: true, evidence: 'confirmed' }),
                );

            const result = await service.execute(
                baseParams(suggestions) as any,
            );

            // Deep-equal the full documented return shape.
            expect(result).toEqual({
                suggestions: [
                    { id: 'k', suggestionContent: 'real leak', improvedCode: 'b' },
                ],
                codeReviewModelUsed: { safeguard: 'test-model' },
            });
        });

        it('verifyWithPromptOnly passes a correct {verdict,evidence} straight through', async () => {
            mockGenerate.mockResolvedValueOnce(
                out({ verdict: false, evidence: 'refuted by guard' }),
            );

            const r = await (service as any).verifyWithPromptOnly(
                { id: 's1', suggestionContent: 'c' },
                mkFeatures({ has_resource_leak: true }),
                baseParams([{ id: 's1' }]),
            );

            expect(r).toEqual({ keep: false, evidence: 'refuted by guard' });
        });
    });

    // ---------------------------------------------------------------- Layer 2
    describe('Layer 2 — OFF-SCHEMA / N-model robustness (feature extraction)', () => {
        // extractFeatures is FAIL-SAFE: any shape it cannot read as
        // {codeSuggestions:[...]} → no features → keep every suggestion. It must
        // never dig a discard signal out of a wrong key, and never drop.
        const offSchema: Array<[string, unknown]> = [
            [
                'a bare array instead of {codeSuggestions}',
                [
                    {
                        id: 's1',
                        features: { is_quality_opinion: true }, // would discard s1 if wrongly read
                    },
                ],
            ],
            [
                'a {result:{...}} wrapper (right data, wrong key)',
                {
                    result: {
                        codeSuggestions: [
                            { id: 's1', features: { is_quality_opinion: true } },
                        ],
                    },
                },
            ],
            ['null', null],
            ['an empty object', {}],
            [
                'a stringified JSON payload (LLM.run returns a parsed object, never a string)',
                JSON.stringify({
                    codeSuggestions: [
                        { id: 's1', features: { is_quality_opinion: true } },
                    ],
                }),
            ],
        ];

        it.each(offSchema)(
            'extractFeatures off-schema (%s) → keeps ALL suggestions, no silent drop',
            async (_label, shape) => {
                const suggestions = [
                    { id: 's1', suggestionContent: 'c1' },
                    { id: 's2', suggestionContent: 'c2' },
                ];
                mockGenerate.mockResolvedValueOnce(out(shape));

                const result = await service.execute(
                    baseParams(suggestions) as any,
                );

                expect(result.suggestions).toEqual(suggestions);
                expect(result.codeReviewModelUsed).toEqual({
                    safeguard: 'test-model',
                });
            },
        );

        it('partial extraction (item missing `features`) → that suggestion kept by default', async () => {
            const suggestions = [{ id: 's1', suggestionContent: 'c1' }];
            mockGenerate.mockResolvedValueOnce(
                out({ codeSuggestions: [{ id: 's1' }] }), // no `features` key
            );

            const result = await service.execute(
                baseParams(suggestions) as any,
            );

            expect(result.suggestions).toEqual(suggestions);
        });

        it('empty `features` object → triage routes to verify (not a silent discard)', async () => {
            // A present-but-empty features object is off-schema (schema requires 13
            // booleans). It must NOT be treated as "all false → discard"; triage
            // falls through to 'verify', and with no sandbox the prompt-only path
            // keeps it on a keep verdict.
            const suggestions = [
                { id: 's1', suggestionContent: 'c1', improvedCode: 'x' },
            ];
            mockGenerate
                .mockResolvedValueOnce(
                    out({ codeSuggestions: [{ id: 's1', features: {} }] }),
                )
                .mockResolvedValueOnce(out({ verdict: true, evidence: 'kept' }));

            const result = await service.execute(
                baseParams(suggestions) as any,
            );

            expect(result.suggestions).toEqual(suggestions);
        });
    });

    describe('Layer 2 — OFF-SCHEMA robustness (agent verification, fail-open)', () => {
        it('off-schema turns (no top-level verdict) never discard → suggestion kept', async () => {
            const suggestions = [
                { id: 's1', suggestionContent: 'leak', improvedCode: 'b' },
            ];
            const remoteCommands = {
                grep: jest.fn().mockResolvedValue('m'),
                read: jest.fn().mockResolvedValue('body'),
                listDir: jest.fn().mockResolvedValue('d'),
            };

            mockGenerate
                .mockResolvedValueOnce(
                    out({
                        codeSuggestions: [
                            {
                                id: 's1',
                                features: mkFeatures({
                                    has_missing_error_handling: true,
                                }),
                            },
                        ],
                    }),
                )
                // every agent turn wraps the verdict in the wrong envelope, so
                // `'verdict' in parsed` is always false → treated as a (bogus) tool
                // call, never a discard → max turns reached → keep.
                .mockResolvedValue(
                    out({ result: { verdict: false, evidence: 'wrapped' } }),
                );

            const result = await service.execute(
                baseParams(suggestions, { remoteCommands }) as any,
            );

            expect(result.suggestions).toEqual(suggestions);
            // A bogus tool name is never dispatched to the sandbox.
            expect(remoteCommands.grep).not.toHaveBeenCalled();
            expect(remoteCommands.read).not.toHaveBeenCalled();
        });

        it('a null agent turn is rejected (re-ask), not consumed as a verdict', async () => {
            const suggestions = [
                { id: 's1', suggestionContent: 'leak', improvedCode: 'b' },
            ];
            const remoteCommands = {
                grep: jest.fn().mockResolvedValue('m'),
                read: jest.fn().mockResolvedValue('body'),
                listDir: jest.fn().mockResolvedValue('d'),
            };

            mockGenerate
                .mockResolvedValueOnce(
                    out({
                        codeSuggestions: [
                            {
                                id: 's1',
                                features: mkFeatures({
                                    has_missing_error_handling: true,
                                }),
                            },
                        ],
                    }),
                )
                .mockResolvedValue(out(null));

            const result = await service.execute(
                baseParams(suggestions, { remoteCommands }) as any,
            );

            expect(result.suggestions).toEqual(suggestions);
        });
    });

    describe('Layer 2 — KNOWN #1786 GAP: prompt-only verifier silently drops on off-schema', () => {
        // verifyWithPromptOnly returns `keep: result.verdict` verbatim. When the
        // model returns a non-throwing off-schema shape whose top-level `verdict`
        // is not a boolean, `keep` becomes `undefined`, and execute's prompt-only
        // fallback then DROPS the suggestion (data loss) instead of applying the
        // documented keep-as-safe-default. These assert the CORRECT (non-degrading)
        // behavior, so they are green today and flip red the day the bug is fixed.
        const promptOnlyOffSchema: Array<[string, unknown]> = [
            ['an empty object', {}],
            ['a {result:{verdict}} wrapper', { result: { verdict: true, evidence: 'x' } }],
            ['a stringified JSON verdict', JSON.stringify({ verdict: true, evidence: 'x' })],
            ['a bare array', [{ verdict: true, evidence: 'x' }]],
        ];

        for (const [label, shape] of promptOnlyOffSchema) {
            it.failing(
                `verifyWithPromptOnly off-schema (${label}) should default to keep=true`,
                async () => {
                    mockGenerate.mockReset();
                    mockGenerate.mockResolvedValueOnce(out(shape));

                    const r = await (service as any).verifyWithPromptOnly(
                        { id: 's1', suggestionContent: 'c' },
                        mkFeatures({ has_resource_leak: true }),
                        baseParams([{ id: 's1' }]),
                    );

                    // Currently `keep` is `undefined` for these shapes → this
                    // assertion fails today (so it.failing is green).
                    expect(r.keep).toBe(true);
                },
            );
        }

        it.failing(
            'execute (prompt-only) must NOT silently drop a suggestion when the verifier returns {}',
            async () => {
                const suggestions = [
                    { id: 's1', suggestionContent: 'real leak', improvedCode: 'b' },
                ];
                mockGenerate
                    .mockResolvedValueOnce(
                        out({
                            codeSuggestions: [
                                {
                                    id: 's1',
                                    features: mkFeatures({
                                        has_missing_error_handling: true,
                                    }),
                                },
                            ],
                        }),
                    )
                    .mockResolvedValueOnce(out({})); // off-schema verifier response

                const result = await service.execute(
                    baseParams(suggestions) as any,
                );

                // Today s1 is dropped (keep=undefined). The safe default is to keep.
                expect(result.suggestions).toEqual(suggestions);
            },
        );
    });

    // ---------------------------------------------------------------- Layer 3
    describe('Layer 3 — FAIL-SAFE (provider error → documented fallback)', () => {
        it('extractFeatures LLM error → keep all + declared shape (never throws past boundary)', async () => {
            const suggestions = [
                { id: 's1', suggestionContent: 'c1' },
                { id: 's2', suggestionContent: 'c2' },
            ];
            mockGenerate.mockRejectedValue(new Error('suspended key'));

            const result = await service.execute(
                baseParams(suggestions) as any,
            );

            expect(result.suggestions).toEqual(suggestions);
            expect(result.codeReviewModelUsed).toEqual({
                safeguard: 'test-model',
            });
        });

        it('verifyWithPromptOnly LLM error → keep=true (safe default)', async () => {
            mockGenerate.mockRejectedValueOnce(new Error('provider 500'));

            const r = await (service as any).verifyWithPromptOnly(
                { id: 's1', suggestionContent: 'c' },
                mkFeatures({ has_resource_leak: true }),
                baseParams([{ id: 's1' }]),
            );

            expect(r.keep).toBe(true);
        });

        it('execute (prompt-only): verifier LLM error keeps the suggestion (fallback catch)', async () => {
            const suggestions = [
                { id: 's1', suggestionContent: 'leak', improvedCode: 'b' },
            ];
            mockGenerate
                .mockResolvedValueOnce(
                    out({
                        codeSuggestions: [
                            {
                                id: 's1',
                                features: mkFeatures({
                                    has_missing_error_handling: true,
                                }),
                            },
                        ],
                    }),
                )
                .mockRejectedValueOnce(new Error('provider 500'));

            const result = await service.execute(
                baseParams(suggestions) as any,
            );

            expect(result.suggestions).toEqual(suggestions);
            expect(result.codeReviewModelUsed).toEqual({
                safeguard: 'test-model',
            });
        });
    });
});

/**
 * parseAgentResponse is the deterministic text→object primitive the agent loop
 * uses to discriminate a tool call from a verdict. Pin its exact contract,
 * including the envelope-sensitivity that makes a wrapped verdict read as a
 * (non-verdict) tool call — the reason off-schema agent turns fail OPEN (keep).
 */
describe('SafeguardPipelineService.parseAgentResponse — parse contract', () => {
    let service: SafeguardPipelineService;

    beforeEach(() => {
        service = new SafeguardPipelineService({} as any, {} as any, {} as any);
    });

    const parse = (t: string) => (service as any).parseAgentResponse(t);

    it('clean JSON object', () => {
        expect(parse('{"verdict":true,"evidence":"e"}')).toEqual({
            verdict: true,
            evidence: 'e',
        });
    });

    it('```json fenced block', () => {
        expect(parse('```json\n{"tool":"read","path":"f"}\n```')).toEqual({
            tool: 'read',
            path: 'f',
        });
    });

    it('prose-wrapped JSON', () => {
        expect(parse('Sure! {"verdict":false,"evidence":"e"} done')).toEqual({
            verdict: false,
            evidence: 'e',
        });
    });

    it('JS // line comments stripped (last resort)', () => {
        expect(parse('{"verdict":true, // note\n"evidence":"e"}')).toEqual({
            verdict: true,
            evidence: 'e',
        });
    });

    it('bare array is valid JSON and returned as-is', () => {
        expect(parse('[{"tool":"read"}]')).toEqual([{ tool: 'read' }]);
    });

    it('empty / whitespace → null', () => {
        expect(parse('')).toBeNull();
        expect(parse('   ')).toBeNull();
    });

    it('non-JSON prose → null', () => {
        expect(parse('I could not decide')).toBeNull();
    });

    it('the literal "null" → null', () => {
        expect(parse('null')).toBeNull();
    });

    it('{result:{verdict}} wrapper parses but `verdict` is NOT top-level (envelope sensitivity)', () => {
        const r = parse('{"result":{"verdict":true}}');
        expect(r).toEqual({ result: { verdict: true } });
        // This is why an off-schema agent verdict is ignored (fail-open), not
        // consumed as a discard.
        expect('verdict' in r).toBe(false);
    });
});

/**
 * FULL LLM.run I/O-contract matrix closure for the PROMPT-ONLY boundary
 * (`verifyWithPromptOnly` + the `execute` prompt-only fallback + fail-safe).
 *
 * Declared schema D = `{ verdict: boolean, evidence: string }`. The method
 * returns `{ keep: result.verdict, evidence: result.evidence }` with NO parse
 * step — it reads `result.verdict` straight off the AI-SDK `experimental_output`
 * (`readOutput` = `experimental_output ?? output`; the real generateText zod
 * check is mocked away, so an off-schema shape flows through verbatim — exactly a
 * json_object-fallback model on the wire).
 *
 * Two structural facts drive the assertions:
 *   - `null`/`undefined` output → `readOutput` yields `undefined` → `result.verdict`
 *     THROWS on property access → the method's `catch` returns the documented safe
 *     default `keep:true`. FAIL-SAFE (real `it`).
 *   - Any NON-null shape whose top-level `verdict` is not a boolean (`{}`, wrong
 *     keys, wrappers, primitives, strings, arrays, `{error}`…) → `result.verdict`
 *     is `undefined`/coerced → `keep` is falsy/wrong → `execute` DROPS the
 *     suggestion with no signal (safeguardPipeline.service.ts:652 `keep: result.verdict`
 *     + :456 `else fallbackDiscarded++`). That is the #1786 silent degradation;
 *     the CORRECT behavior (keep-as-safe-default, or decode the boolean) is pinned
 *     with `it.failing` — green today, red the day the boundary is hardened.
 *     Assertions are NEVER weakened to match the bug.
 */
describe('SafeguardPipelineService — prompt-only boundary FULL I/O matrix (#1786)', () => {
    let service: SafeguardPipelineService;
    let observability: any;

    beforeEach(() => {
        jest.clearAllMocks();
        mockGenerate.mockReset();
        observability = {
            runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
            runLLMInSpan: jest.fn(),
        };
        service = new SafeguardPipelineService(
            observability,
            {} as any,
            {} as any,
        );
    });

    /** Drive verifyWithPromptOnly with a single mocked LLM output shape. */
    const runPromptOnly = async (
        shape: unknown,
    ): Promise<{ keep: any; evidence: any }> => {
        mockGenerate.mockReset();
        mockGenerate.mockResolvedValueOnce(out(shape));
        return (service as any).verifyWithPromptOnly(
            { id: 's1', suggestionContent: 'c' },
            mkFeatures({ has_resource_leak: true }),
            baseParams([{ id: 's1' }]),
        );
    };

    // ============================================================= A. shape zoo
    describe('A. output-shape zoo', () => {
        it('A17 null output → property access throws → safe default keep=true', async () => {
            const r = await runPromptOnly(null);
            expect(r.keep).toBe(true);
            expect(r.evidence).toContain('safe default');
        });
    });

    // =============================================== B. semantic-but-wrong value
    describe('B. semantic-but-wrong value encodings', () => {
        // The model encoded a boolean the wrong way. Correct behavior = decode to
        // a real boolean; prod passes the raw value through → keep is a string or
        // number (wrong precision, silent). Pin the decoded truth (it.failing).
        const encodings: Array<[string, unknown, boolean]> = [
            // 'false' as a string is truthy: passed through raw it keeps a
            // suggestion the model refuted.
            ['B21 boolean-as-string "false"', { verdict: 'false' }, false],
        ];

        for (const [label, shape, expected] of encodings) {
            it.failing(
                `${label} → should decode to strict keep=${expected}`,
                async () => {
                    const r = await runPromptOnly(shape);
                    expect(r.keep).toBe(expected);
                },
            );
        }

        it('B25 dangling reference: features for an id NOT in input → ignored, all input kept', async () => {
            const suggestions = [
                { id: 's1', suggestionContent: 'c1', improvedCode: 'a' },
            ];
            // Discard-worthy feature but for a NON-EXISTENT id (reference out of
            // range). It must not touch s1 (which has no features → kept default).
            mockGenerate.mockResolvedValueOnce(
                out({
                    codeSuggestions: [
                        {
                            id: 'ghost',
                            features: mkFeatures({ is_quality_opinion: true }),
                        },
                    ],
                }),
            );
            const result = await service.execute(
                baseParams(suggestions) as any,
            );
            expect(result.suggestions).toEqual(suggestions);
        });
    });

    // ============================================ D. input variants (execute path)
    describe('D. input variants (execute prompt-only fallback)', () => {
        it('D35 empty input (0 suggestions) → empty output, declared shape', async () => {
            mockGenerate.mockResolvedValueOnce(out({ codeSuggestions: [] }));
            const result = await service.execute(baseParams([]) as any);
            expect(result.suggestions).toEqual([]);
            expect(result.codeReviewModelUsed).toEqual({
                safeguard: 'test-model',
            });
        });

        it('D37 large input → ONE batched feature-extraction call (no chunking), all verified', async () => {
            const N = 40;
            const suggestions = Array.from({ length: N }, (_, i) => ({
                id: `s${i}`,
                suggestionContent: `c${i}`,
                improvedCode: `code${i}`,
            }));
            mockGenerate.mockResolvedValueOnce(
                out({
                    codeSuggestions: suggestions.map((s) => ({
                        id: s.id,
                        features: mkFeatures({
                            has_missing_error_handling: true,
                        }),
                    })),
                }),
            );
            for (let i = 0; i < N; i++) {
                mockGenerate.mockResolvedValueOnce(
                    out({ verdict: true, evidence: 'k' }),
                );
            }
            const result = await service.execute(
                baseParams(suggestions) as any,
            );
            expect(result.suggestions).toEqual(suggestions);
            // 1 batched extraction + N verifications proves no per-chunk extraction.
            expect(mockGenerate).toHaveBeenCalledTimes(N + 1);
        });

        it('D38 duplicate items (same id) → resolved from one feature set consistently', async () => {
            const suggestions = [
                { id: 'dup', suggestionContent: 'c', improvedCode: 'a' },
                { id: 'dup', suggestionContent: 'c', improvedCode: 'a' },
            ];
            // quality_opinion → discard in triage → both dropped, no verify call.
            mockGenerate.mockResolvedValueOnce(
                out({
                    codeSuggestions: [
                        {
                            id: 'dup',
                            features: mkFeatures({ is_quality_opinion: true }),
                        },
                    ],
                }),
            );
            const result = await service.execute(
                baseParams(suggestions) as any,
            );
            expect(result.suggestions).toEqual([]);
            expect(mockGenerate).toHaveBeenCalledTimes(1);
        });

        it('D39 suggestion with null/undefined fields → verify runs without crashing', async () => {
            const suggestions = [
                {
                    id: 's1',
                    suggestionContent: null,
                    existingCode: undefined,
                    filePath: null,
                    improvedCode: 'a',
                },
            ];
            mockGenerate
                .mockResolvedValueOnce(
                    out({
                        codeSuggestions: [
                            {
                                id: 's1',
                                features: mkFeatures({
                                    has_missing_error_handling: true,
                                }),
                            },
                        ],
                    }),
                )
                .mockResolvedValueOnce(out({ verdict: true, evidence: 'k' }));
            const result = await service.execute(
                baseParams(suggestions) as any,
            );
            expect(result.suggestions).toEqual(suggestions);
        });
    });
});
