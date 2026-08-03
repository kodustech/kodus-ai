/**
 * openai module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-01 — the tracer).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted / never double-counted), and D-05 (conformance runs the
 * REAL module boundary via MockLanguageModelV4, not a jest.fn on tracedGenerateText).
 *
 * RED-first: written against the openai.module.ts:114-119 zero stub — the reasoning
 * assertions fail until normalize/normalizeUsage extract real values.
 */
import { openaiModule } from './index';
import { runConformance, type ProviderFixture } from '../kernel/conformance';
import reasoningFixture from './__fixtures__/reasoning.json';
import plainFixture from './__fixtures__/plain.json';

const reasoning = reasoningFixture as ProviderFixture;
const plain = plainFixture as ProviderFixture;

// A minimal build config; apiKey/baseURL are never dialed (offline harness).
const openaiCompatibleCfg = {
    provider: 'openai_compatible',
    model: 'kimi-k2.7-code',
    apiKey: 'test-key',
    baseURL: 'https://api.moonshot.ai/v1',
} as any;

const openaiNativeCfg = {
    provider: 'openai',
    model: 'o3',
    apiKey: 'test-key',
} as any;

describe('openaiModule.normalizeUsage — reasoning split (Q4: detail-OF output)', () => {
    it('reasoning fixture: input/output are the raw counts; reasoning > 0 and NOT subtracted from output', () => {
        const usage = openaiModule.normalizeUsage({ usage: reasoning.usage });

        expect(usage.input).toBe(reasoning.usage.inputTokens);
        // output stays the FULL completion count — reasoning is a subset, do NOT subtract.
        expect(usage.output).toBe(reasoning.usage.outputTokens);
        expect(usage.reasoning).toBe(
            reasoning.usage.outputTokenDetails!.reasoningTokens,
        );
        expect(usage.reasoning).toBeGreaterThan(0);
        // The double-count trap: output must not have reasoning removed from it.
        expect(usage.output).not.toBe(
            reasoning.usage.outputTokens! -
                reasoning.usage.outputTokenDetails!.reasoningTokens!,
        );
    });

    it('plain fixture (no reasoning details): reasoning === 0, a number, never null/undefined', () => {
        const usage = openaiModule.normalizeUsage({ usage: plain.usage });

        expect(usage.input).toBe(plain.usage.inputTokens);
        expect(usage.output).toBe(plain.usage.outputTokens);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('reads the ai@6 flat reasoningTokens fallback shape too', () => {
        const usage = openaiModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        const usage = openaiModule.normalizeUsage({});
        expect(usage).toEqual({ input: 0, output: 0, reasoning: 0 });
    });
});

describe('openaiModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: reasoning.usage, extra: 'left-untouched' };
        const result = openaiModule.normalize(raw);

        expect(result.usage).toEqual(openaiModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('openaiModule capability ↔ behavior (D-05)', () => {
    // NOTE: the openai module's capabilities(model) keys on isOpenAiReasoner
    // (o-series / gpt-5) — it cannot see openai vs openai_compatible. A native
    // reasoner id resolves to 'reasoning_split'; a plain id to 'output_only'.
    // (Encoding Moonshot/Kimi never-downgrade as a reasoning_split capability is
    // the separate Pitfall-2 task, out of scope for this thin tracer — see SUMMARY.)
    it("native reasoner id → usageGranularity 'reasoning_split'", () => {
        expect(openaiModule.capabilities('o3').usageGranularity).toBe(
            'reasoning_split',
        );
        expect(openaiModule.capabilities('gpt-5').usageGranularity).toBe(
            'reasoning_split',
        );
    });

    it("plain id → usageGranularity 'output_only'", () => {
        expect(openaiModule.capabilities('gpt-4o-mini').usageGranularity).toBe(
            'output_only',
        );
    });
});

describe('openaiModule never-downgrade capability (D-00b, Pitfall 2)', () => {
    // A direct-Moonshot BYOK config: openai_compatible + api.moonshot.ai baseURL,
    // which shouldEnableJsonSchema alone would REJECT (not :8000, not allow-listed).
    const moonshotCfg = {
        provider: 'openai_compatible',
        model: 'kimi-k2.7-code',
        apiKey: 'test-key',
        baseURL: 'https://api.moonshot.ai/v1',
    } as any;

    // An unknown openai_compatible upstream with no allow-listed baseURL — must
    // still defer to shouldEnableJsonSchema (i.e. stay OFF), proving the override
    // is additive, not a blanket force-on.
    const unknownCfg = {
        provider: 'openai_compatible',
        model: 'llama-3.1-70b-instruct',
        apiKey: 'test-key',
        baseURL: 'https://my-unknown-proxy.example.com/v1',
    } as any;

    it('Kimi/Moonshot openai_compatible build keeps json_schema ON despite api.moonshot.ai baseURL', () => {
        const model = openaiModule.build(moonshotCfg, {
            structuredOutputs: true,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(true);
    });

    it('unknown openai_compatible upstream still defers to shouldEnableJsonSchema (stays OFF)', () => {
        const model = openaiModule.build(unknownCfg, {
            structuredOutputs: true,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(false);
    });

    it('the override is opt-in only: no structuredOutputs opt-in → OFF even for Kimi', () => {
        const model = openaiModule.build(moonshotCfg, {
            structuredOutputs: false,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(false);
    });

    it("capabilities(kimiId).structuredOutput === 'json_schema' (declared never-downgrade signal)", () => {
        expect(openaiModule.capabilities('kimi-k2.7-code').structuredOutput).toBe(
            'json_schema',
        );
        expect(
            openaiModule.capabilities('moonshotai/kimi-k2-instruct')
                .structuredOutput,
        ).toBe('json_schema');
    });

    it("capabilities(unknownCompatibleId).structuredOutput is NOT json_schema (only known families claim it)", () => {
        expect(
            openaiModule.capabilities('llama-3.1-70b-instruct').structuredOutput,
        ).not.toBe('json_schema');
    });
});

describe('openaiModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('openai_compatible reasoning fixture: SDK-shaped result splits reasoning, output not reduced', async () => {
        const run = await runConformance(
            openaiModule,
            openaiCompatibleCfg,
            reasoning,
        );

        expect(run.usage.input).toBe(reasoning.usage.inputTokens);
        expect(run.usage.output).toBe(reasoning.usage.outputTokens);
        expect(run.usage.reasoning).toBe(
            reasoning.usage.outputTokenDetails!.reasoningTokens,
        );
        expect(run.usage.reasoning).toBeGreaterThan(0);
        // normalize(raw) usage matches normalizeUsage exactly.
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });

    it('openai native plain fixture: reasoning === 0 through the real SDK path', async () => {
        const run = await runConformance(openaiModule, openaiNativeCfg, plain);

        expect(run.usage.input).toBe(plain.usage.inputTokens);
        expect(run.usage.output).toBe(plain.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
    });
});
