/**
 * moonshot module — normalize / normalizeUsage unit proof, never-downgrade
 * build behavior, and offline conformance.
 *
 * Covers: the module owns normalize/normalizeUsage (Q4: reasoning is a detail-OF
 * output, never subtracted); the shared never-downgrade policy keeps json_schema
 * ON for Kimi/Moonshot when opted in; and the managed trial-default factory call
 * shape (no supportsStructuredOutputs field when NOT opted in) — the byte-for-byte
 * reproduction of the old inline exception that keeps byok-to-vercel.env-default
 * case 7/9 green.
 */
import { moonshotModule } from './moonshot.module';
import { runConformance, type ProviderFixture } from './conformance';
import plainFixture from './__fixtures__/moonshot/plain.json';

const plain = plainFixture as ProviderFixture;

const moonshotCfg = {
    provider: 'moonshot',
    model: 'kimi-k2.7-code',
    apiKey: 'test-key',
} as any;

describe('moonshotModule.normalizeUsage — real extraction (Q4: detail-OF output)', () => {
    it('plain fixture: input/output are the raw counts; reasoning === 0 (number, never null)', () => {
        const usage = moonshotModule.normalizeUsage({ usage: plain.usage });

        expect(usage.input).toBe(plain.usage.inputTokens);
        expect(usage.output).toBe(plain.usage.outputTokens);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('reads the ai@7 nested reasoning split when a kimi-thinking upstream reports it', () => {
        const usage = moonshotModule.normalizeUsage({
            usage: {
                inputTokens: 100,
                outputTokens: 500,
                outputTokenDetails: { reasoningTokens: 210 },
            },
        });
        // output stays the FULL completion count — reasoning is a subset, not subtracted.
        expect(usage).toEqual({ input: 100, output: 500, reasoning: 210 });
        expect(usage.output).not.toBe(500 - 210);
    });

    it('reads the ai@6 flat reasoningTokens fallback shape too', () => {
        const usage = moonshotModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(moonshotModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('moonshotModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: plain.usage, extra: 'left-untouched' };
        const result = moonshotModule.normalize(raw);

        expect(result.usage).toEqual(moonshotModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('moonshotModule never-downgrade (D-00b) + managed-default call shape', () => {
    it('opt-in → Kimi/Moonshot keeps json_schema ON (supportsStructuredOutputs:true)', () => {
        const model = moonshotModule.build(moonshotCfg, {
            structuredOutputs: true,
        }) as any;
        expect(model.supportsStructuredOutputs).toBe(true);
    });

    it('NO opt-in (managed default path) → json_schema stays OFF', () => {
        // The old inline exception called createOpenAICompatible with NO
        // supportsStructuredOutputs field on the un-opted-in trial default; the
        // exact no-field factory call is pinned by byok-to-vercel.env-default
        // case 7/9. Here (real SDK) the effective state must not be ON.
        const model = moonshotModule.build(moonshotCfg, {}) as any;
        expect(model.supportsStructuredOutputs).not.toBe(true);
    });

    it("capabilities(kimiId).structuredOutput === 'json_schema' (never-downgrade signal)", () => {
        expect(
            moonshotModule.capabilities('kimi-k2.7-code').structuredOutput,
        ).toBe('json_schema');
        expect(
            moonshotModule.capabilities('moonshotai/kimi-k2-instruct')
                .structuredOutput,
        ).toBe('json_schema');
    });
});

describe('moonshotModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('plain fixture: reasoning === 0 through the real SDK path; output not reduced', async () => {
        const run = await runConformance(moonshotModule, moonshotCfg, plain);

        expect(run.usage.input).toBe(plain.usage.inputTokens);
        expect(run.usage.output).toBe(plain.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });

    it("declares usageGranularity 'output_only'", () => {
        expect(
            moonshotModule.capabilities(moonshotCfg.model).usageGranularity,
        ).toBe('output_only');
    });
});
