/**
 * No-reasoning-double-count provider conformance (Phase 5, plan 05-08 — VERIFY-ONLY).
 *
 * Every provider module's `normalizeUsage` must report `output` as the FULL completion
 * token count, with reasoning carried as a detail-OF that output (a subset), NEVER added
 * on top. This is the invariant the month-to-date aggregate relies on
 * (monthly-spend.use-case.ts:126-129 — "outputTokens already includes reasoningTokens ...
 * so total is input + output to avoid double-counting"). If any provider reported
 * reasoning ADDED to output, the spend aggregate would double-count; this spec fails
 * loudly instead of letting that drift in.
 *
 * Driven data-first over the ACTUAL registry (`REGISTRY.all()`): every registered module
 * must appear in the fixture table below, so adding a provider without a
 * no-double-count fixture fails this suite rather than silently escaping the invariant.
 *
 * A failing assertion is a REAL finding (a residual double-count), NOT a test to relax.
 */
import { REGISTRY } from '../index';
import type { ProviderFixture } from './conformance';
import { buildMockFromFixture, runConformance } from './conformance';
import { normalizeSdkResult, normalizeSdkUsage } from './usage';
import type { ProviderModule, ProviderBuildConfig } from './types';

import { anthropicModule } from '../anthropic/index';
import { openaiModule } from '../openai/index';
import { googleGeminiModule } from '../google-gemini/index';
import { vertexModule } from '../vertex/index';
import { openRouterModule } from '../openrouter/index';
import { bedrockModule } from '../bedrock/index';
import { novitaModule } from '../novita/index';
import { moonshotModule } from '../moonshot/index';
import { azureModule } from '../azure/index';
import { zaiModule } from '../zai/index';

import openaiPlain from '../openai/__fixtures__/plain.json';
import openaiReasoning from '../openai/__fixtures__/reasoning.json';
import anthropicReasoning from '../anthropic/__fixtures__/reasoning.json';
import googlePlain from '../google-gemini/__fixtures__/plain.json';
import vertexPlain from '../vertex/__fixtures__/plain.json';
import openrouterReasoning from '../openrouter/__fixtures__/reasoning.json';
import bedrockPlain from '../bedrock/__fixtures__/plain.json';
import novitaPlain from '../novita/__fixtures__/plain.json';
import moonshotPlain from '../moonshot/__fixtures__/plain.json';
import azurePlain from '../azure/__fixtures__/plain.json';

interface ProviderCase {
    module: ProviderModule;
    /** A representative model id (for the capability ↔ behavior tie-in). */
    model: string;
    fixtures: Array<{ name: string; fixture: ProviderFixture }>;
}

const CASES: ProviderCase[] = [
    {
        module: openaiModule,
        model: 'o3',
        fixtures: [
            { name: 'plain', fixture: openaiPlain as ProviderFixture },
            { name: 'reasoning', fixture: openaiReasoning as ProviderFixture },
        ],
    },
    {
        module: anthropicModule,
        model: 'claude-sonnet-4-5-20250929',
        fixtures: [
            {
                name: 'reasoning',
                fixture: anthropicReasoning as ProviderFixture,
            },
        ],
    },
    {
        module: googleGeminiModule,
        model: 'gemini-2.5-flash',
        fixtures: [{ name: 'plain', fixture: googlePlain as ProviderFixture }],
    },
    {
        module: vertexModule,
        model: 'gemini-2.5-flash',
        fixtures: [{ name: 'plain', fixture: vertexPlain as ProviderFixture }],
    },
    {
        module: openRouterModule,
        model: 'moonshotai/kimi-k2-thinking',
        fixtures: [
            {
                name: 'reasoning',
                fixture: openrouterReasoning as ProviderFixture,
            },
        ],
    },
    {
        module: bedrockModule,
        model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        fixtures: [{ name: 'plain', fixture: bedrockPlain as ProviderFixture }],
    },
    {
        module: novitaModule,
        model: 'meta-llama/llama-3.1-70b-instruct',
        fixtures: [{ name: 'plain', fixture: novitaPlain as ProviderFixture }],
    },
    {
        module: moonshotModule,
        model: 'kimi-k2.7-code',
        fixtures: [{ name: 'plain', fixture: moonshotPlain as ProviderFixture }],
    },
    {
        module: azureModule,
        model: 'gpt-4o',
        fixtures: [{ name: 'plain', fixture: azurePlain as ProviderFixture }],
    },
    {
        // Z.ai speaks the Anthropic protocol → shares its usage extractor, so the
        // anthropic reasoning fixture proves the same no-double-count invariant.
        module: zaiModule,
        model: 'glm-5.2',
        fixtures: [
            {
                name: 'reasoning',
                fixture: anthropicReasoning as ProviderFixture,
            },
        ],
    },
];

/** The aggregate's documented rule (monthly-spend.use-case.ts:126-129). */
const aggregateTotal = (input: number, output: number) => input + output;

describe('provider conformance: registry coverage (no provider escapes the invariant)', () => {
    it('every registered module has a no-double-count fixture case', () => {
        const registered = new Set(REGISTRY.all().map((m) => m.id));
        const covered = new Set(CASES.map((c) => c.module.id));
        // Any registered module missing from CASES → the invariant is unproven for it.
        expect([...registered].sort()).toEqual([...covered].sort());
    });
});

describe.each(CASES)(
    'no reasoning double-count: $module.id.normalizeUsage',
    ({ module, model, fixtures }) => {
        it.each(fixtures)(
            '$name fixture: output is the full completion count; reasoning is a subset, not added on top',
            ({ fixture }) => {
                const usage = module.normalizeUsage({ usage: fixture.usage });
                const expectedReasoning =
                    fixture.usage.outputTokenDetails?.reasoningTokens ??
                    fixture.usage.reasoningTokens ??
                    0;

                // input/output are the RAW recorded counts.
                expect(usage.input).toBe(fixture.usage.inputTokens ?? 0);
                expect(usage.output).toBe(fixture.usage.outputTokens ?? 0);

                // reasoning is always a number (never null/undefined — the
                // observability `reasoning_tokens > 0` guard depends on it).
                expect(typeof usage.reasoning).toBe('number');
                expect(usage.reasoning).toBe(expectedReasoning);

                // THE double-count trap: output already accounts for reasoning, so
                // reasoning is a subset (<= output) and output is NOT reasoning-inflated.
                expect(usage.reasoning).toBeLessThanOrEqual(usage.output);
                if (usage.reasoning > 0) {
                    expect(usage.output).not.toBe(
                        (fixture.usage.outputTokens ?? 0) + usage.reasoning,
                    );
                }
            },
        );

        it.each(fixtures)(
            '$name fixture: aggregate total = input + output matches recorded total (no reasoning added on top)',
            ({ fixture }) => {
                const usage = module.normalizeUsage({ usage: fixture.usage });
                const total = aggregateTotal(usage.input, usage.output);

                // The recorded provider total already equals input + output.
                if (fixture.usage.totalTokens != null) {
                    expect(fixture.usage.totalTokens).toBe(total);
                }

                // A reasoning-added-on-top aggregate would inflate spend; assert the
                // aggregate rule does NOT do that when reasoning is present.
                if (usage.reasoning > 0) {
                    expect(total).not.toBe(
                        usage.input + usage.output + usage.reasoning,
                    );
                }
            },
        );

        it('declares a known usageGranularity, and non-thinking (plain) fixtures surface no reasoning', () => {
            const granularity = module.capabilities(model).usageGranularity;
            // Descriptor sanity — one of the known values.
            expect(['reasoning_split', 'output_only', undefined]).toContain(
                granularity,
            );
            // A non-thinking call never reports a reasoning split, regardless of the
            // descriptor. (The descriptor is a per-provider default: OpenRouter
            // declares 'output_only' yet proxies upstreams that DO surface a split on
            // thinking calls, which normalizeUsage still reads — proven by the
            // per-fixture assertions above. Anthropic's own output_only⇒reasoning-0
            // native-folding case is locked by anthropic.module.spec.ts.)
            for (const { name, fixture } of fixtures) {
                if (name !== 'plain') continue;
                const usage = module.normalizeUsage({ usage: fixture.usage });
                expect(usage.reasoning).toBe(0);
            }
        });
    },
);

/* ===========================================================================
 * FULL I/O CONTRACT MATRIX — the deterministic usage-normalization boundary.
 *
 * TARGET SOURCE: conformance.ts (the offline harness — runConformance /
 * buildMockFromFixture) + the shared normalize layer every provider module
 * delegates to (usage.ts: normalizeSdkUsage / normalizeSdkResult; anthropic
 * index.ts:256-257, openai index.ts:257-258 wire `normalizeUsage:
 * normalizeSdkUsage` / `normalize: normalizeSdkResult` verbatim, so testing the
 * shared functions closes every module at once).
 *
 * DECLARED SCHEMA D:
 *   NormalizedUsage = { input: number; output: number; reasoning: number }
 *   ModelResult     = { usage: NormalizedUsage; raw: unknown }
 *   ConformanceRun  = { model; raw; usage: NormalizedUsage; result: ModelResult }
 * The "inner payload" normalize wants lives at raw.usage.{inputTokens,
 * outputTokens, outputTokenDetails.reasoningTokens | reasoningTokens}.
 *
 * SCOPE = deterministic layer only: usage extraction, fail-safe defaulting,
 * guaranteed return shape, and the harness's request-assembly + fallback. Model
 * decision QUALITY (finding correctness) is the separate eval track, out of scope.
 * Matrix rows keyed [A#]..[E#] to llm-io-contract-matrix.md; N/A rows justified
 * in the returned rowsNA.
 * ======================================================================== */

/** D = NormalizedUsage: the boundary ALWAYS returns exactly these three keys. */
function assertNormalizedShape(u: unknown): asserts u is {
    input: unknown;
    output: unknown;
    reasoning: unknown;
} {
    expect(u && typeof u === 'object').toBe(true);
    expect(Object.keys(u as object).sort()).toEqual([
        'input',
        'output',
        'reasoning',
    ]);
}

const cfg = (over: Partial<ProviderBuildConfig> = {}): ProviderBuildConfig =>
    ({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'sk-test-conformance',
        ...over,
    } as ProviderBuildConfig);

const fx = (over: Partial<ProviderFixture> = {}): ProviderFixture => ({
    text: 'ok',
    finishReason: 'stop',
    usage: { inputTokens: 5, outputTokens: 10 },
    ...over,
});

describe('contract: normalizeSdkUsage — output-shape zoo (A) never throws, always returns D', () => {
    // [A1] Exact D — happy path, correct keys/types, exact extraction.
    it('[A1] exact D → precise extraction (ai@7 nested reasoning)', () => {
        const u = normalizeSdkUsage({
            usage: {
                inputTokens: 5,
                outputTokens: 10,
                outputTokenDetails: { reasoningTokens: 3 },
            },
        });
        expect(u).toEqual({ input: 5, output: 10, reasoning: 3 });
        assertNormalizedShape(u);
    });

    // A2..A19: every off-schema raw safe-defaults to the typed zero triple
    // (documented fallback: `(raw)?.usage ?? {}` then `?? 0`) — never throws,
    // always returns D. This IS the observable safe-default the #1786 rule allows
    // (typed, inspectable), as long as it is NOT a WRONG value masquerading as right.
    const zooZero: Array<[string, unknown]> = [
        ['[A2] bare array raw', [{ inputTokens: 9 }]],
        ['[A3] usage as array (object expected)', { usage: [1, 2, 3] }],
        ['[A4] wrapper key {result:{usage}}', { result: { usage: { inputTokens: 5 } } }],
        ['[A4] wrapper key {data:{usage}}', { data: { usage: { inputTokens: 5 } } }],
        [
            '[A5] double wrapper {result:{result:{usage}}}',
            { result: { result: { usage: { inputTokens: 5 } } } },
        ],
        ['[A6] numeric single-key wrap {"0":{usage}}', { '0': { usage: { inputTokens: 5 } } }],
        ['[A6] {content:{usage}}', { content: { usage: { inputTokens: 5 } } }],
        ['[A7] stringified JSON (no JSON.parse of usage)', '{"usage":{"inputTokens":5}}'],
        ['[A10] renamed snake_case keys (relies on SDK camelCase)', { usage: { input_tokens: 5, output_tokens: 10 } }],
        ['[A11] case/convention mismatch InputTokens', { usage: { InputTokens: 5, OutputTokens: 10 } }],
        ['[A14] empty object raw', {}],
        ['[A14] empty usage object', { usage: {} }],
        ['[A15] empty array raw', []],
        ['[A16] empty string raw', ''],
        ['[A16] whitespace-only raw', '   '],
        ['[A17] null raw', null],
        ['[A17] undefined raw', undefined],
        ['[A18] primitive true', true],
        ['[A18] primitive 0', 0],
        ['[A18] primitive "ok"', 'ok'],
        ['[A19] provider envelope leak {choices:[{message}]}', { choices: [{ message: { content: 'x' } }] }],
    ];
    it.each(zooZero)('%s → typed-zero triple, no throw', (_label, raw) => {
        let u!: ReturnType<typeof normalizeSdkUsage>;
        expect(() => {
            u = normalizeSdkUsage(raw);
        }).not.toThrow();
        assertNormalizedShape(u);
        expect(u).toEqual({ input: 0, output: 0, reasoning: 0 });
    });

    // [A12] Partial object — only some required keys present; the rest default.
    it('[A12] partial usage (only inputTokens) → others zero', () => {
        expect(normalizeSdkUsage({ usage: { inputTokens: 5 } })).toEqual({
            input: 5,
            output: 0,
            reasoning: 0,
        });
    });

    // [A13] Extra unknown keys alongside the right ones — tolerated, not crashed.
    it('[A13] extra unknown usage keys tolerated', () => {
        expect(
            normalizeSdkUsage({
                usage: {
                    inputTokens: 5,
                    outputTokens: 10,
                    cachedTokens: 2,
                    foo: 'bar',
                    outputTokenDetails: { reasoningTokens: 4, extra: 1 },
                },
            }),
        ).toEqual({ input: 5, output: 10, reasoning: 4 });
    });

    // [A20] Reasoning leak / ai@6 flat fallback + ai@7 nested precedence.
    it('[A20] ai@6 flat reasoningTokens read when no nested detail', () => {
        expect(
            normalizeSdkUsage({
                usage: { inputTokens: 1, outputTokens: 10, reasoningTokens: 4 },
            }),
        ).toEqual({ input: 1, output: 10, reasoning: 4 });
    });
    it('[A20] ai@7 nested outputTokenDetails wins over ai@6 flat', () => {
        expect(
            normalizeSdkUsage({
                usage: {
                    inputTokens: 1,
                    outputTokens: 10,
                    reasoningTokens: 99,
                    outputTokenDetails: { reasoningTokens: 7 },
                },
            }).reasoning,
        ).toBe(7);
    });
});

describe('contract: normalizeSdkUsage — semantic-but-wrong (B)', () => {
    // [B21] Number-as-string: DECLARED type is number, prod passes the string
    // through untouched (usage.ts:23 `u.inputTokens ?? 0` — a truthy string is
    // NOT ??-replaced and is NOT coerced). A wrong-typed value ships silently —
    // the #1786 class. Pinned as it.failing asserting the CORRECT (number) type;
    // green today, turns red when usage.ts coerces/rejects non-number counts.
    it.failing('[B21] number-as-string count should be a number, not passed through', () => {
        const u = normalizeSdkUsage({ usage: { inputTokens: '5', outputTokens: 10 } });
        expect(typeof u.input).toBe('number');
    });

    // [B23] Boolean/non-number as a count — same silent passthrough class.
    it.failing('[B23] boolean count should be a number, not passed through', () => {
        const u = normalizeSdkUsage({ usage: { inputTokens: true, outputTokens: 10 } });
        expect(typeof u.input).toBe('number');
    });

    // [B25] Dangling / out-of-range reference: reasoning is a SUBSET of output
    // (usage.ts doc: "reasoning is a detail-OF output"; the aggregate at
    // monthly-spend.use-case.ts:126-129 depends on reasoning <= output). A raw
    // with reasoningTokens > outputTokens violates that, and normalizeSdkUsage
    // does NOT clamp — the impossible value ships silently. Pinned it.failing
    // asserting the clamp (green today, red when usage.ts:25-26 clamps).
    it.failing('[B25] reasoning > output should be clamped to a subset (<= output)', () => {
        const u = normalizeSdkUsage({
            usage: { outputTokens: 10, outputTokenDetails: { reasoningTokens: 100 } },
        });
        expect(u.reasoning).toBeLessThanOrEqual(u.output);
    });

    // [B27] Unicode / emoji live in TEXT, not the numeric usage fields; proven at
    // the harness layer (see [D40]). Numeric counts carry no string encoding.
});

describe('contract: harness + normalize — unparseable / transport fail-safe (C)', () => {
    // [C30] The normalize boundary is pure and NEVER throws, on ANY input.
    it('[C30] normalizeSdkUsage never throws across the whole zoo', () => {
        const nasty: unknown[] = [
            null,
            undefined,
            NaN,
            Symbol('x') as unknown,
            () => 0,
            { usage: null },
            { usage: undefined },
            { get usage() {
                return { inputTokens: 3 };
            } },
        ];
        for (const raw of nasty) {
            expect(() => normalizeSdkUsage(raw)).not.toThrow();
            assertNormalizedShape(normalizeSdkUsage(raw));
        }
    });

    // [C30] A conformance run whose module.build throws must SURFACE (a harness
    // exists to fail loudly), not swallow — the correct fail-safe for a test gate.
    it('[C30] runConformance propagates a throwing module.build', async () => {
        const boom = {
            id: 'boom',
            build: () => {
                throw new Error('build blew up');
            },
            normalize: normalizeSdkResult,
            normalizeUsage: normalizeSdkUsage,
        } as unknown as ProviderModule;
        await expect(runConformance(boom, cfg(), fx())).rejects.toThrow('build blew up');
    });

    // [C30] A throwing normalize propagates too (not silently defaulted).
    it('[C30] runConformance propagates a throwing normalizeUsage', async () => {
        const boom = {
            id: 'boom2',
            build: () => ({}) as never,
            normalize: normalizeSdkResult,
            normalizeUsage: () => {
                throw new Error('normalize blew up');
            },
        } as unknown as ProviderModule;
        await expect(runConformance(boom, cfg(), fx())).rejects.toThrow('normalize blew up');
    });

    // [C31] Error object returned instead of throwing → typed-zero, no throw.
    it('[C31] {error:...} raw → typed-zero triple', () => {
        expect(normalizeSdkUsage({ error: 'model failed' })).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });

    // [C32] Empty success (content:'', finishReason:'length') — usage still read,
    // text preserved, no throw — end-to-end through the real SDK assembly.
    it('[C32] empty-success fixture: usage extracted, empty text preserved', async () => {
        const run = await runConformance(
            openaiModule,
            cfg({ model: 'o3' }),
            fx({ text: '', finishReason: 'length', usage: { inputTokens: 7, outputTokens: 0 } }),
        );
        expect(run.usage).toEqual({ input: 7, output: 0, reasoning: 0 });
        expect((run.raw as { text: string }).text).toBe('');
    });

    // [C33] Refusal (content_filter / "I cannot help") — usage extracted, no throw;
    // normalize does not inspect finishReason or content.
    it('[C33] refusal fixture: usage extracted, no throw', async () => {
        const run = await runConformance(
            openaiModule,
            cfg({ model: 'o3' }),
            fx({
                text: 'I cannot help with that.',
                finishReason: 'content_filter',
                usage: { inputTokens: 4, outputTokens: 6 },
            }),
        );
        expect(run.usage).toEqual({ input: 4, output: 6, reasoning: 0 });
        expect(run.result.usage).toEqual({ input: 4, output: 6, reasoning: 0 });
    });
});

describe('contract: input variants (D)', () => {
    // [D35] Empty input.
    it('[D35] empty usage input → zero triple', () => {
        expect(normalizeSdkUsage({ usage: {} })).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });

    // [D36] Single item — one fixture end-to-end returns the full ConformanceRun.
    it('[D36] single fixture through runConformance → full declared run shape', async () => {
        const run = await runConformance(
            openaiModule,
            cfg({ model: 'o3' }),
            fx({ usage: { inputTokens: 11, outputTokens: 22, outputTokenDetails: { reasoningTokens: 5 } } }),
        );
        expect(Object.keys(run).sort()).toEqual(['model', 'raw', 'result', 'usage'].sort());
        assertNormalizedShape(run.usage);
        expect(run.usage).toEqual({ input: 11, output: 22, reasoning: 5 });
        expect(run.result).toEqual({ usage: run.usage, raw: run.raw });
    });

    // [D37] Large counts crossing any numeric/batch boundary → passed through exactly.
    it('[D37] very large token counts survive intact', () => {
        expect(
            normalizeSdkUsage({
                usage: {
                    inputTokens: 1_000_000_000_000,
                    outputTokens: 999_999_999_999,
                    outputTokenDetails: { reasoningTokens: 500_000_000_000 },
                },
            }),
        ).toEqual({
            input: 1_000_000_000_000,
            output: 999_999_999_999,
            reasoning: 500_000_000_000,
        });
    });

    // [D39] Null/undefined required fields → ?? defaults to zero.
    it('[D39] null/undefined usage fields → zero triple', () => {
        expect(
            normalizeSdkUsage({
                usage: {
                    inputTokens: null,
                    outputTokens: undefined,
                    outputTokenDetails: { reasoningTokens: null },
                },
            }),
        ).toEqual({ input: 0, output: 0, reasoning: 0 });
    });

    // [D40] Special chars / emoji / whitespace / large text — text is carried
    // through the SDK assembly untouched; usage still extracted. (Also closes B27.)
    it('[D40] emoji/unicode/whitespace text preserved, usage extracted', async () => {
        const weird = '  🚀\n\t  café — 変更 ' + 'x'.repeat(5000);
        const run = await runConformance(
            openaiModule,
            cfg({ model: 'o3' }),
            fx({ text: weird, usage: { inputTokens: 3, outputTokens: 9 } }),
        );
        expect((run.raw as { text: string }).text).toBe(weird);
        expect(run.usage).toEqual({ input: 3, output: 9, reasoning: 0 });
    });

    // [D42] Order permutation is metamorphic: object key insertion order does not
    // change the extracted triple; and the function is idempotent/deterministic.
    it('[D42] key-order permutation → identical triple; deterministic', () => {
        const a = normalizeSdkUsage({
            usage: {
                outputTokenDetails: { reasoningTokens: 2 },
                outputTokens: 10,
                inputTokens: 5,
            },
        });
        const b = normalizeSdkUsage({
            usage: {
                inputTokens: 5,
                outputTokens: 10,
                outputTokenDetails: { reasoningTokens: 2 },
            },
        });
        expect(a).toEqual(b);
        expect(a).toEqual(normalizeSdkUsage({ usage: { inputTokens: 5, outputTokens: 10, outputTokenDetails: { reasoningTokens: 2 } } }));
    });
});

describe('contract: provider/model matrix (E) — normalization is provider-agnostic', () => {
    // The gate that DOES branch on provider (structured-output policy) lives in the
    // capability descriptor, NOT in normalize. Prove the descriptor carries both
    // branches, then prove normalize ignores the branch entirely.
    it('[E] capabilities().structuredOutput carries both gate branches', () => {
        // strict json_schema group
        expect(openaiModule.capabilities('gpt-4o').structuredOutput).toBe('json_schema');
        expect(googleGeminiModule.capabilities('gemini-2.5-flash').structuredOutput).toBe('json_schema');
        expect(azureModule.capabilities('gpt-4o').structuredOutput).toBe('json_schema');
        // json_object fallback group
        expect(novitaModule.capabilities('meta-llama/llama-3.1-70b-instruct').structuredOutput).toBe('json_object');
        expect(openRouterModule.capabilities('x/y').structuredOutput).toBe('json_object');
        // openai_compatible over an unknown upstream downgrades to json_object.
        expect(openaiModule.capabilities('some-unknown-proxy-model').structuredOutput).toBe('json_object');
    });

    // Every registered module delegates usage extraction to the SAME shared
    // function — so the A/B/C zoo behaves identically no matter the gate branch.
    it('[E] every registered module wires the shared normalize (no divergent copy)', () => {
        for (const m of REGISTRY.all()) {
            expect(m.normalizeUsage).toBe(normalizeSdkUsage);
            expect(m.normalize).toBe(normalizeSdkResult);
        }
    });

    // Run representative off-schema rows through a strict-gate module and a
    // fallback-gate module — identical output proves no provider branch in parse.
    const offSchemaRows: Array<[string, unknown, { input: number; output: number; reasoning: number }]> = [
        ['[E×A12] partial', { usage: { inputTokens: 5 } }, { input: 5, output: 0, reasoning: 0 }],
        ['[E×A17] null', null, { input: 0, output: 0, reasoning: 0 }],
        ['[E×A19] envelope leak', { choices: [{ message: { content: 'x' } }] }, { input: 0, output: 0, reasoning: 0 }],
        ['[E×A20] flat reasoning', { usage: { inputTokens: 1, outputTokens: 8, reasoningTokens: 3 } }, { input: 1, output: 8, reasoning: 3 }],
    ];
    const strictModules = [openaiModule, googleGeminiModule, azureModule];
    const fallbackModules = [novitaModule, openRouterModule];
    it.each(offSchemaRows)('%s → identical across strict & fallback gate modules', (_l, raw, expected) => {
        for (const m of [...strictModules, ...fallbackModules, anthropicModule, moonshotModule, zaiModule]) {
            expect(m.normalizeUsage(raw)).toEqual(expected);
        }
    });
});

describe('contract: harness request-assembly & return shape (conformance.ts)', () => {
    // runConformance throws its DOCUMENTED error when build() returns a falsy model.
    it('runConformance signals a falsy build explicitly (documented throw)', async () => {
        const falsy = {
            id: 'falsy-provider',
            build: () => null,
            normalize: normalizeSdkResult,
            normalizeUsage: normalizeSdkUsage,
        } as unknown as ProviderModule;
        await expect(runConformance(falsy, cfg(), fx())).rejects.toThrow(
            /falsy-provider\.build\(cfg\) returned a falsy LanguageModel/,
        );
    });

    // buildMockFromFixture threads cfg.model onto the mock and replays the fixture
    // (exercises toV4DoGenerateUsage: total stays full; text = max(output-reasoning,0)).
    it('buildMockFromFixture threads model id and replays fixture usage', async () => {
        const mock = buildMockFromFixture(cfg({ model: 'my-model-x' }), fx({
            text: 'hello',
            usage: { inputTokens: 2, outputTokens: 10, outputTokenDetails: { reasoningTokens: 100 } },
        }));
        expect(mock.modelId).toBe('my-model-x');
        const gen = await (mock as unknown as { doGenerate: (o: unknown) => Promise<any> }).doGenerate({});
        expect(gen.content).toEqual([{ type: 'text', text: 'hello' }]);
        // reasoning (100) exceeds output (10) → text clamped to 0, total stays full 10.
        expect(gen.usage.outputTokens.text).toBe(0);
        expect(gen.usage.outputTokens.total).toBe(10);
        expect(gen.usage.outputTokens.reasoning).toBe(100);
    });

    // The boundary ALWAYS returns the declared ConformanceRun / ModelResult shape,
    // and result.usage === the standalone normalizeUsage output (single source).
    it('runConformance always returns the declared shape; result mirrors usage', async () => {
        const run = await runConformance(
            anthropicModule,
            cfg({ provider: 'anthropic', model: 'claude-sonnet-4-5-20250929', apiKey: 'sk-a' }),
            fx({ usage: { inputTokens: 3, outputTokens: 4 } }),
        );
        assertNormalizedShape(run.usage);
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
        expect(run.usage).toEqual({ input: 3, output: 4, reasoning: 0 });
    });

    // normalizeSdkResult ALWAYS returns { usage:D, raw } for any input — the
    // guaranteed ModelResult shape across every layer.
    it('normalizeSdkResult always returns {usage:D, raw} (even off-schema)', () => {
        for (const raw of [null, undefined, {}, 'x', { usage: { inputTokens: 5 } }]) {
            const r = normalizeSdkResult(raw);
            expect(Object.keys(r).sort()).toEqual(['raw', 'usage']);
            assertNormalizedShape(r.usage);
            expect(r.raw).toBe(raw);
        }
    });
});
