/**
 * openrouter module — normalize / normalizeUsage unit proof + offline conformance
 * (Phase 3, plan 03-11).
 *
 * Covers D-01 (module owns normalize/normalizeUsage), Q4 (reasoning is a detail-OF
 * output, never subtracted), and D-05 (conformance runs the REAL module boundary
 * via the 03-01 harness). OpenRouter forwards the upstream usage, so a
 * reasoning-capable upstream (moonshotai/kimi-k2-thinking) surfaces a reasoning split.
 *
 * RED-first: written against the openrouter.module.ts:73/76 zero stub — the
 * reasoning assertions fail until normalize/normalizeUsage extract real values.
 */
import { openRouterModule } from './openrouter.module';
import { runConformance, type ProviderFixture } from './conformance';
import reasoningFixture from './__fixtures__/openrouter/reasoning.json';

const reasoning = reasoningFixture as ProviderFixture;

// A minimal build config; apiKey/baseURL are never dialed (offline harness).
const openRouterCfg = {
    provider: 'open_router',
    model: 'moonshotai/kimi-k2-thinking',
    apiKey: 'test-key',
} as any;

describe('openRouterModule.normalizeUsage — reasoning split (Q4: detail-OF output)', () => {
    it('reasoning fixture: input/output are the raw counts; reasoning > 0 and NOT subtracted from output', () => {
        const usage = openRouterModule.normalizeUsage({ usage: reasoning.usage });

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

    it('non-reasoning response: reasoning === 0, a number, never null/undefined', () => {
        const usage = openRouterModule.normalizeUsage({
            usage: { inputTokens: 512, outputTokens: 128, totalTokens: 640 },
        });
        expect(usage.input).toBe(512);
        expect(usage.output).toBe(128);
        expect(usage.reasoning).toBe(0);
        expect(typeof usage.reasoning).toBe('number');
        expect(usage.reasoning).not.toBeNull();
    });

    it('reads the ai@6 flat reasoningTokens fallback shape too', () => {
        const usage = openRouterModule.normalizeUsage({
            usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 7 },
        });
        expect(usage).toEqual({ input: 10, output: 20, reasoning: 7 });
    });

    it('missing usage → all-zero NormalizedUsage (numbers, never undefined)', () => {
        expect(openRouterModule.normalizeUsage({})).toEqual({
            input: 0,
            output: 0,
            reasoning: 0,
        });
    });
});

describe('openRouterModule.normalize — { usage, raw }', () => {
    it('returns usage === normalizeUsage(raw) and the untouched raw', () => {
        const raw = { usage: reasoning.usage, extra: 'left-untouched' };
        const result = openRouterModule.normalize(raw);

        expect(result.usage).toEqual(openRouterModule.normalizeUsage(raw));
        expect(result.raw).toBe(raw);
    });
});

describe('openRouterModule offline conformance (real boundary: build → SDK → normalize)', () => {
    it('reasoning fixture: SDK-shaped result splits reasoning, output not reduced', async () => {
        const run = await runConformance(
            openRouterModule,
            openRouterCfg,
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
});
