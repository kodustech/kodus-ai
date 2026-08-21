/**
 * google-gemini module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-10).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted), and D-05 (conformance runs the REAL module boundary via
 * the 03-01 harness, not a jest.fn on tracedGenerateText).
 *
 * A1 FINDING (code-verified, RESEARCH A1): @ai-sdk/google v4 splits reasoning —
 * candidatesTokenCount -> outputTokens.text, thoughtsTokenCount -> outputTokens.reasoning
 * (dist/index.js:295-307), with outputTokens.total = candidates + thoughts. generateText
 * flattens outputTokens.reasoning -> usage.outputTokenDetails.reasoningTokens. The plain
 * fixture has no thoughts (reasoning === 0); the reasoning>0 split is proven inline.
 *
 * RED-first: written against the google-gemini.module.ts:76/79 zero stub — the usage
 * assertions fail until normalize/normalizeUsage extract real values.
 */
import { googleGeminiModule } from './index';
import { runConformance, type ProviderFixture } from '../kernel/conformance';
import plainFixture from './__fixtures__/plain.json';

const plain = plainFixture as ProviderFixture;

// A minimal build config; apiKey/baseURL are never dialed (offline harness).
const geminiCfg = {
    provider: 'google_gemini',
    model: 'gemini-2.5-flash',
    apiKey: 'test-key',
} as any;

describe('googleGeminiModule.normalizeUsage — real extraction (Q4: detail-OF output)', () => {
    it('plain fixture: input/output are the raw counts; reasoning === 0 (number, never null)', () => {
        const usage = googleGeminiModule.normalizeUsage({ usage: plain.usage });

        expect(usage.input).toBe(plain.usage.inputTokens);
        expect(usage.output).toBe(plain.usage.outputTokens);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('splits gemini thoughtsTokenCount (nested reasoningTokens) — output stays the full completion count', () => {
        // Mirrors the @ai-sdk/google mapping: outputTokens.total already includes
        // thoughts, and the flattened result carries reasoning under
        // outputTokenDetails.reasoningTokens.
        const usage = googleGeminiModule.normalizeUsage({
            usage: {
                inputTokens: 640,
                outputTokens: 900,
                outputTokenDetails: { reasoningTokens: 700 },
            },
        });
        expect(usage).toEqual({ input: 640, output: 900, reasoning: 700 });
        // The double-count trap: output must NOT have reasoning removed from it.
        expect(usage.output).not.toBe(900 - 700);
    });

    it('reads the ai@6 flat reasoningTokens fallback shape too', () => {
        const usage = googleGeminiModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(googleGeminiModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('googleGeminiModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: plain.usage, extra: 'left-untouched' };
        const result = googleGeminiModule.normalize(raw);

        expect(result.usage).toEqual(googleGeminiModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('googleGeminiModule capability ↔ behavior (D-05)', () => {
    it("gemini-2.5 reasoner → usageGranularity 'reasoning_split' (the SDK splits thoughtsTokenCount)", () => {
        expect(googleGeminiModule.capabilities('gemini-2.5-flash').usageGranularity).toBe(
            'reasoning_split',
        );
    });

    it("declares structuredOutput 'json_schema' — gemini responseSchema", () => {
        expect(googleGeminiModule.capabilities('gemini-2.5-flash').structuredOutput).toBe(
            'json_schema',
        );
    });
});

describe('googleGeminiModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('plain fixture: reasoning === 0 through the real SDK path; output not reduced', async () => {
        const run = await runConformance(googleGeminiModule, geminiCfg, plain);

        expect(run.usage.input).toBe(plain.usage.inputTokens);
        expect(run.usage.output).toBe(plain.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
        // normalize(raw) usage matches normalizeUsage exactly.
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });
});
