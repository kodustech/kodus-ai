/**
 * bedrock module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-11).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted), and D-05 (conformance runs the REAL module boundary
 * via the 03-01 harness, not a jest.fn on tracedGenerateText).
 *
 * RED-first: written against the bedrock.module.ts:53/56 zero stub — the usage
 * assertions fail until normalize/normalizeUsage extract real values.
 */
import { encrypt } from '@libs/common/utils/crypto';
import { bedrockModule } from './bedrock.module';
import { runConformance, type ProviderFixture } from './conformance';
import plainFixture from './__fixtures__/bedrock/plain.json';

const plain = plainFixture as ProviderFixture;

// A minimal build config; no real AWS is dialed (offline harness). Bedrock's
// build() DECRYPTS awsBearerToken (unlike apiKey passthrough providers), so the
// dummy token is round-tripped through the local crypto key to decrypt cleanly.
const bedrockCfg = {
    provider: 'amazon_bedrock',
    model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    awsRegion: 'us-east-1',
    awsBearerToken: encrypt('offline-conformance-bearer'),
} as any;

describe('bedrockModule.normalizeUsage — real extraction (Q4: detail-OF output)', () => {
    it('plain fixture: input/output are the raw counts; reasoning === 0 (number, never null)', () => {
        const usage = bedrockModule.normalizeUsage({ usage: plain.usage });

        expect(usage.input).toBe(plain.usage.inputTokens);
        expect(usage.output).toBe(plain.usage.outputTokens);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('reads the ai@7 nested reasoning split when a bedrock thinking model reports it', () => {
        const usage = bedrockModule.normalizeUsage({
            usage: {
                inputTokens: 100,
                outputTokens: 500,
                outputTokenDetails: { reasoningTokens: 320 },
            },
        });
        // output stays the FULL completion count — reasoning is a subset, not subtracted.
        expect(usage).toEqual({ input: 100, output: 500, reasoning: 320 });
        expect(usage.output).not.toBe(500 - 320);
    });

    it('reads the ai@6 flat reasoningTokens fallback shape too', () => {
        const usage = bedrockModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(bedrockModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('bedrockModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: plain.usage, extra: 'left-untouched' };
        const result = bedrockModule.normalize(raw);

        expect(result.usage).toEqual(bedrockModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('bedrockModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('plain fixture: reasoning === 0 through the real SDK path; output not reduced', async () => {
        const run = await runConformance(bedrockModule, bedrockCfg, plain);

        expect(run.usage.input).toBe(plain.usage.inputTokens);
        expect(run.usage.output).toBe(plain.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
        // normalize(raw) usage matches normalizeUsage exactly.
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });

    it("declares usageGranularity 'output_only' — matches the plain fixture behavior", () => {
        expect(bedrockModule.capabilities(bedrockCfg.model).usageGranularity).toBe(
            'output_only',
        );
    });
});
