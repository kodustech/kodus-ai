/**
 * anthropic module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-10).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted / double-counted), and D-05 (conformance runs the REAL
 * module boundary via the 03-01 harness, not a jest.fn on tracedGenerateText).
 *
 * A1 FINDING (code-verified, RESEARCH A1): @ai-sdk/anthropic v4 sets
 * `outputTokens.reasoning: void 0` (dist/index.js:1969-1973) — Anthropic's Messages
 * API `usage` reports NO separate thinking-token count; thinking tokens are billed
 * INTO output_tokens. So even a Claude extended-thinking response yields reasoning === 0
 * at the SDK boundary the module consumes, and anthropic's usageGranularity is
 * 'output_only', NOT 'reasoning_split'. Fabricating a reasoning>0 anthropic fixture
 * would be the exact "wrong reasoning-field guess" T-03-20 warns against.
 *
 * RED-first: written against the anthropic.module.ts:101/104 zero stub — the usage
 * assertions fail until normalize/normalizeUsage extract real values.
 */
import { anthropicModule } from './index';
import { runConformance, type ProviderFixture } from '../kernel/conformance';
import reasoningFixture from './__fixtures__/reasoning.json';

const reasoning = reasoningFixture as ProviderFixture;

// A minimal build config; apiKey/baseURL are never dialed (offline harness).
const anthropicNativeCfg = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
    apiKey: 'test-key',
} as any;

describe('anthropicModule.reasoning — effort=none owns "thinking off"', () => {
    const off = (model: string, provider = 'anthropic') =>
        anthropicModule.reasoning!(
            { provider, model, apiKey: '' } as any,
            'none',
        );

    it('says `disabled` out loud on models that think by default (Opus 5)', () => {
        expect(off('claude-opus-5')).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
    });

    it('omits the config on legacy models (never think unasked)', () => {
        expect(off('claude-sonnet-4-5')).toEqual({});
    });

    it('leaves Fable thinking on — the API rejects `disabled`', () => {
        expect(off('claude-fable-5')).toEqual({});
    });

    it('says `disabled` out loud on DISABLE-able compatible models (Kimi K2.6)', () => {
        // K2.5/K2.6 enable thinking by DEFAULT and accept `{ type: 'disabled' }`.
        // Omitting it left thinking ON, which 400s a forced-tool_choice call —
        // the PR#144/#145/#146 Kody Rules failure. "Off" must be explicit.
        expect(off('kimi-k2.6', 'anthropic_compatible')).toEqual({
            anthropic: { thinking: { type: 'disabled' } },
        });
    });

    it('OMITS the config on ALWAYS-thinking compatible models (Kimi k2.7-code, k3 — no disable)', () => {
        // k2.7-code and k3 think permanently and expose no disable — sending
        // `{ type: 'disabled' }` is invalid. Omitting IS the only "off"; the
        // structured executor reroutes these to json (no forced tool_choice).
        expect(off('kimi-k2.7-code', 'anthropic_compatible')).toEqual({});
        expect(off('kimi-k3', 'anthropic_compatible')).toEqual({});
    });
});

describe('anthropicModule.normalizeUsage — real extraction (Q4: detail-OF output)', () => {
    it('extended-thinking fixture: input/output are the raw counts; reasoning === 0 (anthropic folds thinking into output_tokens)', () => {
        const usage = anthropicModule.normalizeUsage({ usage: reasoning.usage });

        expect(usage.input).toBe(reasoning.usage.inputTokens);
        // output stays the FULL completion count (it already includes thinking tokens).
        expect(usage.output).toBe(reasoning.usage.outputTokens);
        // A1: anthropic does NOT surface a separate reasoning count.
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('reads the ai@7 nested reasoning split IF an anthropic-compatible upstream ever reports it', () => {
        const usage = anthropicModule.normalizeUsage({
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
        const usage = anthropicModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(anthropicModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('anthropicModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: reasoning.usage, extra: 'left-untouched' };
        const result = anthropicModule.normalize(raw);

        expect(result.usage).toEqual(anthropicModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('anthropicModule capability ↔ behavior (D-05)', () => {
    it("declares usageGranularity 'output_only' — the AI SDK never splits anthropic reasoning (A1)", () => {
        expect(
            anthropicModule.capabilities(anthropicNativeCfg.model)
                .usageGranularity,
        ).toBe('output_only');
    });

    it("declares structuredOutput 'none' — anthropic does structured output via tool use", () => {
        expect(
            anthropicModule.capabilities(anthropicNativeCfg.model)
                .structuredOutput,
        ).toBe('none');
    });
});

describe('anthropicModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('extended-thinking fixture: reasoning === 0 through the real SDK path; output not reduced', async () => {
        const run = await runConformance(
            anthropicModule,
            anthropicNativeCfg,
            reasoning,
        );

        expect(run.usage.input).toBe(reasoning.usage.inputTokens);
        expect(run.usage.output).toBe(reasoning.usage.outputTokens);
        expect(run.usage.reasoning).toBe(0);
        expect(typeof run.usage.reasoning).toBe('number');
        // normalize(raw) usage matches normalizeUsage exactly.
        expect(run.result.usage).toEqual(run.usage);
        expect(run.result.raw).toBe(run.raw);
    });
});
