/**
 * vertex module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-10).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted), and D-05 (conformance runs the REAL module boundary via
 * the 03-01 harness, not a jest.fn on tracedGenerateText).
 *
 * A1 FINDING (code-verified, RESEARCH A1): @ai-sdk/google-vertex v5 reuses the
 * @ai-sdk/google usage mapping (thoughtsTokenCount -> outputTokens.reasoning), so
 * Gemini-on-Vertex splits reasoning; Claude-on-Vertex folds thinking into output like
 * native anthropic (reasoning not separately reported). generateText flattens
 * outputTokens.reasoning -> usage.outputTokenDetails.reasoningTokens. The plain fixture
 * carries no thoughts (reasoning === 0); the reasoning>0 split is proven inline.
 *
 * The build config uses a bogus (non-SA-JSON) apiKey: vertexModelFromSaJson returns
 * null and build() falls back to createGoogleGenerativeAI — a truthy LanguageModel,
 * which is all the offline conformance needs (the mock, not this model, serves generate).
 *
 * RED-first: written against the vertex.module.ts:76/79 zero stub — the usage
 * assertions fail until normalize/normalizeUsage extract real values.
 */
import { vertexModule } from './vertex.module';
import { runConformance, type ProviderFixture } from './conformance';
import plainFixture from './__fixtures__/vertex/plain.json';

const plain = plainFixture as ProviderFixture;

// A minimal build config; no real Vertex is dialed (offline harness). The apiKey is
// not a valid base64 SA JSON, so build() takes the AI-Studio fallback path.
const vertexCfg = {
    provider: 'google_vertex',
    model: 'gemini-2.5-flash',
    apiKey: 'not-a-service-account-json',
    vertexLocation: 'global',
} as any;

describe('vertexModule.normalizeUsage — real extraction (Q4: detail-OF output)', () => {
    it('plain fixture: input/output are the raw counts; reasoning === 0 (number, never null)', () => {
        const usage = vertexModule.normalizeUsage({ usage: plain.usage });

        expect(usage.input).toBe(plain.usage.inputTokens);
        expect(usage.output).toBe(plain.usage.outputTokens);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('splits Gemini-on-Vertex thoughtsTokenCount (nested reasoningTokens) — output stays the full count', () => {
        const usage = vertexModule.normalizeUsage({
            usage: {
                inputTokens: 720,
                outputTokens: 1000,
                outputTokenDetails: { reasoningTokens: 640 },
            },
        });
        expect(usage).toEqual({ input: 720, output: 1000, reasoning: 640 });
        // The double-count trap: output must NOT have reasoning removed from it.
        expect(usage.output).not.toBe(1000 - 640);
    });

    it('reads the ai@6 flat reasoningTokens fallback shape too', () => {
        const usage = vertexModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(vertexModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('vertexModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: plain.usage, extra: 'left-untouched' };
        const result = vertexModule.normalize(raw);

        expect(result.usage).toEqual(vertexModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('vertexModule capability ↔ behavior (D-05)', () => {
    it("gemini-2.5-on-Vertex reasoner → usageGranularity 'reasoning_split'", () => {
        expect(vertexModule.capabilities('gemini-2.5-flash').usageGranularity).toBe(
            'reasoning_split',
        );
    });

    it("declares structuredOutput 'json_schema'", () => {
        expect(vertexModule.capabilities('gemini-2.5-flash').structuredOutput).toBe(
            'json_schema',
        );
    });
});

describe('vertexModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('plain fixture: reasoning === 0 through the real SDK path; output not reduced', async () => {
        const run = await runConformance(vertexModule, vertexCfg, plain);

        expect(run.usage.input).toBe(plain.usage.inputTokens);
        expect(run.usage.output).toBe(plain.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
        // normalize(raw) usage matches normalizeUsage exactly.
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });
});
