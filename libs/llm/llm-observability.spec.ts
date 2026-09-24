/**
 * CONTRACT tests for the LLM observability PORT boundary.
 *
 * TARGET: libs/llm/llm-observability.ts — the narrow dependency-inversion port
 * (`LlmObservability` interface + `setLlmObservability`/`getLlmObservability`
 * registry) that `LLM.run` (structured-review-call.ts / agent-loop-call.ts)
 * reads to wrap every model call in a billing span.
 *
 * The port's single implementation and the deterministic logic under test —
 * `runAiSdkLLMInSpan` + the private `buildUsageSpanAttributes` (usage/cost span
 * attribute assembly) — live in libs/core/log/observability.service.ts. We drive
 * the REAL service (constructed with an inert `{} as any` ConfigService and an
 * injected capturing obs instance) so these assertions bind the actual prod
 * assembly, not a re-implementation.
 *
 * SCOPE = the deterministic layer only:
 *   - the registry (set/get/reset, last-wins),
 *   - usage/cost span-attribute assembly from `result.usage`,
 *   - missing / partial / mis-typed usage fields,
 *   - the RETURN-SHAPE guarantee (exec result flows out unchanged),
 *   - the fail-safe throw path (billed-but-failed usage recorded, transport
 *     failure never writes a zero-token span, error always rethrown).
 *
 * NOT in scope: whether a model's decision is correct (eval track).
 *
 * Matrix mapping (llm-io-contract-matrix.md): this boundary consumes a TYPED AI
 * SDK result object and reads `result.usage` (AiSdkUsageInput: null-safe,
 * deep-partial). It does NOT parse a JSON/markdown/prose text envelope and does
 * NOT branch on model/provider policy — so the text-parsing rows (8,9,28,29),
 * the boolean/enum/index/dup-key value-encoding rows (21,22,23,24,25,26), the
 * envelope-unwrap rows that fold into one robustness case (5,6), and the
 * batching rows (37,38,41) are N/A with reasons in the structured result. Usage
 * reading is provider-agnostic by construction (ai-sdk-usage.ts) — dimension E
 * is exercised as the anthropic-vs-openai cache-token shape, not as a policy
 * gate this boundary never consults.
 */

import {
    setLlmObservability,
    getLlmObservability,
    type LlmObservability,
} from '@libs/llm/llm-observability';
import { ObservabilityService } from '@libs/core/log/observability.service';

// ---------------------------------------------------------------------------
// Harness: real ObservabilityService + injected capturing obs instance.
// runAiSdkLLMInSpan -> runInSpan -> getObsInstance() (uses currentInstance).
// We inject a fake obs whose span.setAttributes accumulates every attribute the
// boundary emits, so we can assert the assembled cost-span schema exactly.
// ---------------------------------------------------------------------------
function makeSvc(): {
    svc: ObservabilityService;
    captured: Record<string, any>;
} {
    const svc = new (ObservabilityService as any)({} as any);
    const captured: Record<string, any> = {};
    const span = {
        setAttributes: (a: Record<string, any>) => Object.assign(captured, a),
    };
    (svc as any).currentInstance = {
        startSpan: () => span,
        withSpan: (_s: any, fn: any) => fn(),
        getContext: () => ({ correlationId: 'corr-1' }),
    };
    return { svc, captured };
}

/** The `gen_ai.usage.*` subset of the assembled span attributes. */
function usageAttrs(captured: Record<string, any>): Record<string, any> {
    return Object.fromEntries(
        Object.entries(captured).filter(([k]) =>
            k.startsWith('gen_ai.usage.'),
        ),
    );
}

// The ObservabilityService constructor calls setLlmObservability(this). Snapshot
// and restore the module-global port so this suite never leaks into others.
let originalPort: LlmObservability | undefined;
beforeAll(() => {
    originalPort = getLlmObservability();
});
afterAll(() => {
    setLlmObservability(originalPort);
});

// =====================================================================
// The registry — the exported surface of the target file itself.
// (Foundational; also the getter's "always returns declared type" guarantee.)
// =====================================================================
describe('registry: set/get/reset', () => {
    afterEach(() => setLlmObservability(originalPort));

    it('get returns exactly what was set (identity)', () => {
        const impl = { runAiSdkLLMInSpan: jest.fn() } as any;
        setLlmObservability(impl);
        expect(getLlmObservability()).toBe(impl);
    });

    it('set(undefined) → get returns undefined (call runs without a span)', () => {
        setLlmObservability({ runAiSdkLLMInSpan: jest.fn() } as any);
        setLlmObservability(undefined);
        expect(getLlmObservability()).toBeUndefined();
    });

    it('last write wins (re-registration overwrites, no accumulation)', () => {
        const a = { runAiSdkLLMInSpan: jest.fn() } as any;
        const b = { runAiSdkLLMInSpan: jest.fn() } as any;
        setLlmObservability(a);
        setLlmObservability(b);
        expect(getLlmObservability()).toBe(b);
        expect(getLlmObservability()).not.toBe(a);
    });

    it('getter is always the declared type-or-undefined, never throws', () => {
        setLlmObservability(undefined);
        expect(() => getLlmObservability()).not.toThrow();
        const impl = { runAiSdkLLMInSpan: jest.fn() } as any;
        setLlmObservability(impl);
        const got = getLlmObservability();
        expect(typeof got!.runAiSdkLLMInSpan).toBe('function');
    });

    it('constructing the concrete service registers it as the port', () => {
        const { svc } = makeSvc();
        expect(getLlmObservability()).toBe(svc);
    });
});

// =====================================================================
// A. Output-shape zoo — the shape of the AI SDK result / its `usage` field.
// The boundary reads `result?.usage` (null-safe) and returns `result` unchanged.
// =====================================================================
describe('A. result/usage shape zoo', () => {
    it('[row 1] exact usage → precise gen_ai.usage.* + result returned unchanged', async () => {
        const { svc, captured } = makeSvc();
        const payload = {
            text: 'ok',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        };
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'agent::phase',
            model: 'gpt-4o',
            exec: async () => payload,
        });
        expect(out).toBe(payload); // return-shape guarantee: same reference
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 5,
            'gen_ai.usage.total_tokens': 15,
        });
        expect(captured['gen_ai.response.model']).toBe('gpt-4o');
    });

    it('[row 2] bare array result (no .usage) → zeros, array returned unchanged', async () => {
        const { svc, captured } = makeSvc();
        const arr = [{ finding: 1 }, { finding: 2 }];
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => arr as any,
        });
        expect(out).toBe(arr);
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 0,
            'gen_ai.usage.output_tokens': 0,
            'gen_ai.usage.total_tokens': 0,
        });
    });

    it('[row 3] usage as a wrong container (array) → null-safe field access → zeros', async () => {
        const { svc, captured } = makeSvc();
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => ({ usage: [1, 2, 3] as any }),
        });
        expect(out).toEqual({ usage: [1, 2, 3] });
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
    });

    it('[row 4] usage nested under a wrapper key → top-level undefined → zeros, no crash, unchanged', async () => {
        const { svc, captured } = makeSvc();
        // Contract: usage is read from result.usage (top-level). A misplaced,
        // nested usage is out-of-contract input; the boundary must not crash and
        // must pass the object through untouched — it records zeros, no throw.
        const payload = {
            result: { usage: { inputTokens: 99, outputTokens: 99 } },
        };
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => payload as any,
        });
        expect(out).toBe(payload);
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
    });

    it('[row 7] usage as a stringified JSON blob → field access on string → zeros', async () => {
        const { svc, captured } = makeSvc();
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () =>
                ({ usage: '{"inputTokens":5}' } as any),
        });
        expect(out).toEqual({ usage: '{"inputTokens":5}' });
        expect(usageAttrs(captured)['gen_ai.usage.input_tokens']).toBe(0);
    });

    it('[row 10] renamed snake_case usage keys are NOT read (camelCase contract) → zeros', async () => {
        const { svc, captured } = makeSvc();
        // The SDK normalizes every provider to camelCase before we see it
        // (ai-sdk-usage.ts). A raw snake_case leak is out-of-contract; the reader
        // reads only camelCase, so input_tokens/output_tokens are not picked up.
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () =>
                ({
                    usage: { input_tokens: 100, output_tokens: 50 },
                } as any),
        });
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 0,
            'gen_ai.usage.output_tokens': 0,
            'gen_ai.usage.total_tokens': 0,
        });
        expect(out).toBeDefined();
    });

    it('[row 11] convention mismatch recovered via the declared legacy fallbacks (ai@6 flat names)', async () => {
        const { svc, captured } = makeSvc();
        // The reader intentionally accepts the ai@6 flat aliases for the fields
        // where mixed-version shims still emit them.
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () =>
                ({
                    usage: {
                        inputTokens: 100,
                        outputTokens: 20,
                        totalTokens: 120,
                        cachedInputTokens: 40, // legacy → cacheReadTokens
                        cacheCreationInputTokens: 10, // legacy → cacheWriteTokens
                        reasoningTokens: 7, // legacy flat reasoning
                    },
                } as any),
        });
        expect(captured['gen_ai.usage.cache_read_input_tokens']).toBe(40);
        expect(captured['gen_ai.usage.cache_creation_input_tokens']).toBe(10);
        expect(captured['gen_ai.usage.reasoning_tokens']).toBe(7);
    });

    it('[row 12] partial usage (only inputTokens) → total DERIVED as input+output', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => ({ usage: { inputTokens: 30 } }),
        });
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 30,
            'gen_ai.usage.output_tokens': 0,
            'gen_ai.usage.total_tokens': 30, // 30 + 0, not undefined
        });
    });

    it('[row 13] extra unknown keys on usage are tolerated; real fields still read', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () =>
                ({
                    usage: {
                        inputTokens: 4,
                        outputTokens: 6,
                        totalTokens: 10,
                        somethingWeird: 'ignore-me',
                        nested: { junk: true },
                    },
                } as any),
        });
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 4,
            'gen_ai.usage.output_tokens': 6,
            'gen_ai.usage.total_tokens': 10,
        });
        expect(captured).not.toHaveProperty('somethingWeird');
    });

    it('[row 14] empty usage object {} → all zeros', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => ({ usage: {} }),
        });
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 0,
            'gen_ai.usage.output_tokens': 0,
            'gen_ai.usage.total_tokens': 0,
        });
    });

    it('[row 15] usage as empty array → zeros', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => ({ usage: [] as any }),
        });
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
    });

    it('[row 16] usage as empty string → zeros', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => ({ usage: '' as any }),
        });
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
    });

    it('[row 17] null / undefined / absent usage → zeros, result unchanged', async () => {
        for (const u of [null, undefined]) {
            const { svc, captured } = makeSvc();
            const payload = { text: 'x', usage: u as any };
            const out = await svc.runAiSdkLLMInSpan({
                spanName: 'a::b',
                exec: async () => payload,
            });
            expect(out).toBe(payload);
            expect(usageAttrs(captured)).toEqual({
                'gen_ai.usage.input_tokens': 0,
                'gen_ai.usage.output_tokens': 0,
                'gen_ai.usage.total_tokens': 0,
            });
        }
        // result with no `usage` key at all
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            // Deliberately off-contract: the point of the case is a result
            // with no `usage` key at all, which the declared exec type forbids.
            exec: async () =>
                ({ text: 'no usage key' }) as unknown as Awaited<
                    ReturnType<Parameters<typeof svc.runAiSdkLLMInSpan>[0]['exec']>
                >,
        });
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
    });

    it('[row 18] primitive where object expected (usage = true/0/"ok") → zeros, no crash', async () => {
        for (const prim of [true, 0, 'ok']) {
            const { svc, captured } = makeSvc();
            await svc.runAiSdkLLMInSpan({
                spanName: 'a::b',
                exec: async () => ({ usage: prim as any }),
            });
            expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
        }
    });

    it('[row 19] provider envelope leak ({choices:[...]}) → no top-level usage → zeros, returned unchanged', async () => {
        const { svc, captured } = makeSvc();
        const envelope = {
            choices: [{ message: { content: '{}' } }],
        };
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => envelope as any,
        });
        expect(out).toBe(envelope);
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
    });

    it('[row 20] reasoning tokens in nested outputTokenDetails are recovered (not dropped)', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () =>
                ({
                    usage: {
                        inputTokens: 100,
                        outputTokens: 20,
                        totalTokens: 120,
                        outputTokenDetails: { reasoningTokens: 9 },
                    },
                } as any),
        });
        expect(captured['gen_ai.usage.reasoning_tokens']).toBe(9);
    });
});

// =====================================================================
// B. Semantic-but-wrong value encoding — attribute-value guarantees.
// (Boolean/enum/index/dup-key encodings do not apply; see rowsNA.)
// =====================================================================
describe('B. value-encoding guarantees', () => {
    it('[row 27] unicode / emoji / newlines in string attrs (model, route) are preserved verbatim', async () => {
        const { svc, captured } = makeSvc();
        const model = 'grøk-π/日本語-🚀\nv2';
        const route = 'codeReview\t✅';
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            model,
            route,
            exec: async () => ({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        });
        expect(captured['gen_ai.response.model']).toBe(model);
        expect(captured.route).toBe(route);
    });
});

// =====================================================================
// C. Unparseable / transport — the fail-safe layer.
// =====================================================================
describe('C. transport / fail-safe', () => {
    it('[row 30] exec throws a transport error (no usage) → rethrows, records NO zero-token usage span', async () => {
        const { svc, captured } = makeSvc();
        const err = new Error('ECONNRESET');
        await expect(
            svc.runAiSdkLLMInSpan({
                spanName: 'a::b',
                exec: async () => {
                    throw err;
                },
            }),
        ).rejects.toBe(err); // never swallowed past the boundary
        // A transport failure billed nothing → must not write a zero-token span.
        expect(usageAttrs(captured)).toEqual({});
        expect(captured.error).toBe(true);
    });

    it('[row 31] exec RETURNS an {error} object (no throw) → passed through unchanged, not reinterpreted', async () => {
        const { svc, captured } = makeSvc();
        const payload = { error: 'model said no', usage: undefined };
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => payload as any,
        });
        expect(out).toBe(payload); // boundary does not interpret {error}
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(0);
        expect(captured.error).toBeUndefined(); // returned normally, not errored
    });

    it('[row 32] empty success (content:"" , finish_reason length) → usage recorded, result unchanged', async () => {
        const { svc, captured } = makeSvc();
        const payload = {
            text: '',
            finishReason: 'length',
            usage: { inputTokens: 8, outputTokens: 0, totalTokens: 8 },
        };
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => payload,
        });
        expect(out).toBe(payload);
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 8,
            'gen_ai.usage.output_tokens': 0,
            'gen_ai.usage.total_tokens': 8,
        });
    });

    it('[row 33] refusal prose result (content_filter) → returned unchanged, usage recorded', async () => {
        const { svc, captured } = makeSvc();
        const payload = {
            text: 'I cannot help with that.',
            finishReason: 'content_filter',
            usage: { inputTokens: 12, outputTokens: 6, totalTokens: 18 },
        };
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            exec: async () => payload,
        });
        expect(out).toBe(payload);
        expect(usageAttrs(captured)['gen_ai.usage.total_tokens']).toBe(18);
    });

    it('[row 34] error CARRYING usage (billed-but-failed parse) → usage recorded BEFORE rethrow', async () => {
        const { svc, captured } = makeSvc();
        // AI_NoObjectGeneratedError class: provider answered + billed, SDK hands
        // usage back on the error. It must be recorded, not lost, then rethrown.
        const err = Object.assign(new Error('AI_NoObjectGeneratedError'), {
            usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
            finishReason: 'error',
        });
        await expect(
            svc.runAiSdkLLMInSpan({
                spanName: 'a::b',
                exec: async () => {
                    throw err;
                },
            }),
        ).rejects.toBe(err);
        expect(usageAttrs(captured)).toEqual({
            'gen_ai.usage.input_tokens': 50,
            'gen_ai.usage.output_tokens': 10,
            'gen_ai.usage.total_tokens': 60,
        });
        expect(captured.finishReason).toBe('error');
        expect(captured.error).toBe(true);
    });

    it('[row 34b] abort-style error with all-zero usage → no zero-token span, rethrown', async () => {
        const { svc, captured } = makeSvc();
        const err = Object.assign(new Error('AbortError'), {
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
        await expect(
            svc.runAiSdkLLMInSpan({
                spanName: 'a::b',
                exec: async () => {
                    throw err;
                },
            }),
        ).rejects.toBe(err);
        expect(usageAttrs(captured)).toEqual({}); // all-zero → skipped
    });
});

// =====================================================================
// D. Input variants — the params fed INTO the boundary.
// =====================================================================
describe('D. input variants', () => {
    it('[row 35] minimal/empty params (only spanName + exec) → still returns a valid usage span shape', async () => {
        const { svc, captured } = makeSvc();
        const out = await svc.runAiSdkLLMInSpan({
            spanName: 'solo::run',
            exec: async () => ({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        });
        expect(out).toEqual({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
        // The billing-critical trio is ALWAYS present, even with no metadata.
        expect(captured['gen_ai.usage.total_tokens']).toBe(2);
    });

    it('[row 36] single happy call threads every optional attribute through', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'review::finder',
            runName: 'finder-run',
            model: 'claude-sonnet-4',
            byokModelId: 'byok-123',
            credentialId: 'cred-xyz',
            route: 'codeReview',
            usedFallback: true,
            attrs: { organizationId: 'org-1', teamId: 'team-2', type: 'byok' },
            exec: async () => ({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }),
        });
        expect(captured['gen_ai.run.name']).toBe('finder-run');
        expect(captured['gen_ai.response.model']).toBe('claude-sonnet-4');
        expect(captured.byokModelId).toBe('byok-123');
        expect(captured.credentialId).toBe('cred-xyz');
        expect(captured.route).toBe('codeReview');
        expect(captured.usedFallback).toBe(true);
        expect(captured.organizationId).toBe('org-1');
        expect(captured.teamId).toBe('team-2');
        expect(captured.type).toBe('byok');
    });

    it('[row 39] undefined/null optional params are OMITTED, never recorded as literal undefined', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            model: undefined,
            byokModelId: undefined,
            credentialId: undefined,
            route: undefined,
            usedFallback: undefined,
            exec: async () => ({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        });
        expect(captured['gen_ai.response.model']).toBeUndefined();
        expect(captured).not.toHaveProperty('byokModelId');
        expect(captured).not.toHaveProperty('credentialId');
        expect(captured).not.toHaveProperty('route');
        expect(captured).not.toHaveProperty('usedFallback');
        // usedFallback:false IS meaningful and must be recorded (it != null).
        const { svc: svc2, captured: cap2 } = makeSvc();
        await svc2.runAiSdkLLMInSpan({
            spanName: 'a::b',
            usedFallback: false,
            exec: async () => ({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
        });
        expect(cap2.usedFallback).toBe(false);
    });

    it('[row 40] huge token counts + whitespace-only model string pass through faithfully', async () => {
        const { svc, captured } = makeSvc();
        const big = 5_000_000;
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            model: '   ',
            exec: async () =>
                ({ usage: { inputTokens: big, outputTokens: big, totalTokens: big * 2 } }),
        });
        expect(captured['gen_ai.usage.total_tokens']).toBe(big * 2);
        expect(captured['gen_ai.response.model']).toBe('   ');
    });

    it('[row 42] param key-order permutation → identical assembled attrs (metamorphic)', async () => {
        const usage = { inputTokens: 7, outputTokens: 8, totalTokens: 15 };
        const { svc: s1, captured: c1 } = makeSvc();
        await s1.runAiSdkLLMInSpan({
            spanName: 'a::b',
            model: 'm',
            route: 'r',
            byokModelId: 'bk',
            exec: async () => ({ usage }),
        });
        const { svc: s2, captured: c2 } = makeSvc();
        await s2.runAiSdkLLMInSpan({
            byokModelId: 'bk',
            route: 'r',
            model: 'm',
            exec: async () => ({ usage }),
            spanName: 'a::b',
        });
        const strip = (c: Record<string, any>) => {
            const { durationMs, ...rest } = c;
            return rest;
        };
        expect(strip(c1)).toEqual(strip(c2));
    });
});

// =====================================================================
// E. Provider dimension — usage reading is provider-agnostic by construction
// (the SDK normalizes every provider before this boundary). This boundary does
// NOT consult structured-output-gate; the A/B/C policy branches do not apply
// here — the provider shape that DOES vary is the cache-token detail block.
// =====================================================================
describe('E. provider-agnostic usage reading', () => {
    it('anthropic-style nested cache details (cacheRead + cacheWrite) recovered', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            model: 'claude-sonnet-4',
            exec: async () =>
                ({
                    usage: {
                        inputTokens: 100,
                        outputTokens: 20,
                        totalTokens: 120,
                        inputTokenDetails: {
                            cacheReadTokens: 40,
                            cacheWriteTokens: 10,
                        },
                    },
                } as any),
        });
        expect(captured['gen_ai.usage.cache_read_input_tokens']).toBe(40);
        expect(captured['gen_ai.usage.cache_creation_input_tokens']).toBe(10);
    });

    it('openai-style usage (no cache details) → cache attrs OMITTED, not recorded as 0', async () => {
        const { svc, captured } = makeSvc();
        await svc.runAiSdkLLMInSpan({
            spanName: 'a::b',
            model: 'gpt-4o',
            exec: async () =>
                ({ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
        });
        // Cache attrs are only emitted when > 0 — keeps the schema clean for
        // providers that don't cache. Same reader, both providers.
        expect(captured['gen_ai.usage.cache_read_input_tokens']).toBeUndefined();
        expect(captured['gen_ai.usage.cache_creation_input_tokens']).toBeUndefined();
        expect(captured['gen_ai.usage.total_tokens']).toBe(120);
    });
});

// =====================================================================
// Cross-cutting: the return-shape guarantee holds at EVERY layer, including
// when NO port is registered (the caller runs exec directly).
// =====================================================================
describe('return-shape guarantee across layers', () => {
    afterEach(() => setLlmObservability(originalPort));

    it('runAiSdkLLMInSpan returns the exact exec value for every result shape', async () => {
        const shapes: any[] = [
            { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            [{ x: 1 }],
            'a raw string result',
            42,
            null,
            { nested: { deep: true }, usage: {} },
        ];
        for (const shape of shapes) {
            const { svc } = makeSvc();
            const out = await svc.runAiSdkLLMInSpan({
                spanName: 'a::b',
                exec: async () => shape,
            });
            expect(out).toEqual(shape);
        }
    });

    it('port-absent fallback: caller pattern (getLlmObservability() ?? exec()) still yields the exec result', async () => {
        setLlmObservability(undefined);
        const payload = { findings: [], usage: { inputTokens: 1 } };
        const obs = getLlmObservability();
        // This mirrors structured-review-call.ts / agent-loop-call.ts: no port
        // registered → run exec directly, same return value, no span, no throw.
        const out = obs
            ? await obs.runAiSdkLLMInSpan({ spanName: 'a::b', exec: async () => payload })
            : await (async () => payload)();
        expect(out).toBe(payload);
        expect(obs).toBeUndefined();
    });
});
