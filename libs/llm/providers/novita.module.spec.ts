/**
 * novita module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-11).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted), and D-05 (conformance runs the REAL module boundary
 * via the 03-01 harness).
 *
 * RED-first: written against the novita.module.ts:54/57 zero stub — the usage
 * assertions fail until normalize/normalizeUsage extract real values.
 */
import { novitaModule } from './novita.module';
import { runConformance, type ProviderFixture } from './conformance';
import plainFixture from './__fixtures__/novita/plain.json';

const plain = plainFixture as ProviderFixture;

// A minimal build config; apiKey/baseURL are never dialed (offline harness).
const novitaCfg = {
    provider: 'novita',
    model: 'meta-llama/llama-3.1-70b-instruct',
    apiKey: 'test-key',
} as any;

describe('novitaModule.normalizeUsage — real extraction (Q4: detail-OF output)', () => {
    it('plain fixture: input/output are the raw counts; reasoning === 0 (number, never null)', () => {
        const usage = novitaModule.normalizeUsage({ usage: plain.usage });

        expect(usage.input).toBe(plain.usage.inputTokens);
        expect(usage.output).toBe(plain.usage.outputTokens);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('reads the ai@7 nested reasoning split when a novita upstream reports it', () => {
        const usage = novitaModule.normalizeUsage({
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
        const usage = novitaModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(novitaModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('novitaModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: plain.usage, extra: 'left-untouched' };
        const result = novitaModule.normalize(raw);

        expect(result.usage).toEqual(novitaModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('novitaModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('plain fixture: reasoning === 0 through the real SDK path; output not reduced', async () => {
        const run = await runConformance(novitaModule, novitaCfg, plain);

        expect(run.usage.input).toBe(plain.usage.inputTokens);
        expect(run.usage.output).toBe(plain.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
        // normalize(raw) usage matches normalizeUsage exactly.
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });

    it("declares usageGranularity 'output_only' — matches the plain fixture behavior", () => {
        expect(novitaModule.capabilities(novitaCfg.model).usageGranularity).toBe(
            'output_only',
        );
    });
});
