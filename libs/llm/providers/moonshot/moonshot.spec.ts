/**
 * moonshot module — Kimi as a first-class Anthropic-protocol BRAND.
 *
 * Kimi's stored transport is the brand id `moonshot`; the module is built from the
 * shared `anthropicBrandModule` factory, so every protocol behavior routes through
 * the anthropic module over `anthropic_compatible`. This proves the brand exposes
 * the Anthropic-protocol contract (structured output via tool-use, ephemeral system
 * cache, budget thinking) — NOT the
 * old OpenAI-compatible `/v1` path (that path now lives only on the openai module,
 * for a manually-typed `api.moonshot.ai/v1` custom endpoint).
 */
import { moonshotModule } from './index';
import { anthropicModule } from '../anthropic/index';

const moonshotCfg = {
    provider: 'moonshot',
    model: 'kimi-k2.7-code',
    apiKey: 'test-key',
    baseURL: 'https://api.moonshot.ai/anthropic',
} as any;

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

    // Both of these used to assert something the vendor contradicts, and both
    // were wrong in the SAME direction: they sent a temperature to a model that
    // does not read one. platform.kimi.ai is explicit per model —
    //   k2.7-code: "temperature is not modifiable and thinking is always on;
    //               neither needs to be set"
    //   k2.6:      "temperature is not modifiable, so no need to set it"
    // — so the field must be OMITTED, not pinned and not passed through.
    // Captured on the wire before the change: k2.7-code received `temperature: 1`
    // and k2.6 received the stored 0.7.
    it('temperature policy: k2.7-code — unmodifiable, so omitted rather than pinned', () => {
        // A pin says "1 is the only sound value"; this is the stronger claim,
        // that the field has no effect at all. Sending 1 is not harmless — it
        // reads, in a request log, like a value someone chose.
        expect(moonshotModule.temperaturePolicy!(moonshotCfg)).toEqual({
            kind: 'unsupported',
        });
    });

    it('temperature policy: k2.6 — disable-able thinking, still unmodifiable temperature', () => {
        // The two facts are independent, and conflating them is what produced
        // the old answer: k2.6 CAN turn thinking off, which made it look like an
        // ordinary adjustable model, while its temperature is fixed by the vendor
        // in every mode.
        const k26 = { ...moonshotCfg, model: 'kimi-k2.6' };
        expect(moonshotModule.temperaturePolicy!(k26)).toEqual({
            kind: 'unsupported',
        });
    });

    it('temperature policy: k2.5 keeps its temperature — no source says otherwise', () => {
        // The scope line. platform.kimi.ai documents k2.6 and k2.7-code; it does
        // not cover k2.5, and inferring the rule from a sibling is exactly what
        // this table exists to avoid. Omitting would be the SAFER guess and is
        // still a guess.
        const k25 = { ...moonshotCfg, model: 'kimi-k2.5' };
        expect(moonshotModule.temperaturePolicy!(k25)).toEqual({
            kind: 'adjustable',
        });
    });
});
