/**
 * moonshot module — Kimi as a first-class Anthropic-protocol BRAND.
 *
 * Kimi's stored transport is the brand id `moonshot`; the module is built from the
 * shared `anthropicBrandModule` factory, so every protocol behavior routes through
 * the anthropic module over `anthropic_compatible`. This proves the brand exposes
 * the Anthropic-protocol contract (structured output via tool-use, ephemeral system
 * cache, budget thinking) and the shared no-double-count usage extractor — NOT the
 * old OpenAI-compatible `/v1` path (that path now lives only on the openai module,
 * for a manually-typed `api.moonshot.ai/v1` custom endpoint).
 */
import { moonshotModule } from './index';
import { anthropicModule } from '../anthropic/index';
import { runConformance, type ProviderFixture } from '../kernel/conformance';
import plainFixture from './__fixtures__/plain.json';

const plain = plainFixture as ProviderFixture;

const moonshotCfg = {
    provider: 'moonshot',
    model: 'kimi-k2.7-code',
    apiKey: 'test-key',
    baseURL: 'https://api.moonshot.ai/anthropic',
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

describe('moonshotModule — Anthropic-protocol brand contract', () => {
    it('exposes the Anthropic capability shape (structured output via tool-use, not json_schema)', () => {
        const caps = moonshotModule.capabilities('kimi-k2.7-code');
        // Over the Anthropic protocol, structured output is tool-use → 'none' at
        // this tier (NOT the OpenAI-compatible json_schema the old /v1 path used).
        expect(caps.structuredOutput).toBe('none');
        expect(caps.toolCalling).toBe('native');
        expect(caps.usageGranularity).toBe('output_only');
        // The Anthropic system prompt is cacheable — the brand inherits it.
        expect(caps.promptCaching).toBe(true);
        // Kimi is a THINKING model → the brand overrides supportsReasoning to true
        // (the claude-only reasoning-config resolver would report false, which the
        // UI showed as "doesn't support reasoning").
        expect(caps.supportsReasoning).toBe(true);
        // Otherwise identical to the anthropic module for the same id (one source).
        expect(caps).toEqual({
            ...anthropicModule.capabilities('kimi-k2.7-code'),
            supportsReasoning: true,
        });
    });

    it('emits NO inline cache marker — Kimi caches automatically (marker ignored)', () => {
        // Unlike native Anthropic, Moonshot/Kimi auto-caches and ignores the
        // explicit cache_control breakpoint (verified live: cache_read = full input
        // on the 2nd identical call with no marker). So the brand drops the marker.
        expect(moonshotModule.systemCacheControl!(moonshotCfg)).toBeUndefined();
    });

    it("reasoning 'none' → OMITS for always-thinking k2.7-code; EXPLICIT disabled for k2.6; a set effort → Anthropic budget thinking", () => {
        // k2.7-code (moonshotCfg) thinks PERMANENTLY and exposes no disable —
        // omitting the config is the only "off"; the executor reroutes it to json.
        expect(moonshotModule.reasoning!(moonshotCfg, 'none')).toEqual({});
        // K2.6 CAN be disabled — "off" is said out loud (the PR#144/#145/#146 fix).
        const k26 = { ...moonshotCfg, model: 'kimi-k2.6' };
        expect(moonshotModule.reasoning!(k26, 'none')).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
        // Compatible endpoints never implement adaptive thinking → always budget.
        expect(
            JSON.stringify(moonshotModule.reasoning!(moonshotCfg, 'medium')),
        ).toMatch(/"type":"enabled".*budgetTokens/);
    });

    it('accepts sampling params (Kimi over the compatible endpoint is not gated)', () => {
        expect(moonshotModule.supportsSamplingParams!(moonshotCfg)).toBe(true);
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

    it('build() returns a model object over the Anthropic protocol', () => {
        expect(moonshotModule.build(moonshotCfg)).toBeDefined();
    });
});
