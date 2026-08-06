/**
 * No-reasoning-double-count provider conformance (Phase 5, plan 05-08 — VERIFY-ONLY).
 *
 * Every provider module's `normalizeUsage` must report `output` as the FULL completion
 * token count, with reasoning carried as a detail-OF that output (a subset), NEVER added
 * on top. This is the invariant the month-to-date aggregate relies on
 * (monthly-spend.use-case.ts:126-129 — "outputTokens already includes reasoningTokens ...
 * so total is input + output to avoid double-counting"). If any provider reported
 * reasoning ADDED to output, the spend aggregate would double-count; this spec fails
 * loudly instead of letting that drift in.
 *
 * Driven data-first over the ACTUAL registry (`REGISTRY.all()`): every registered module
 * must appear in the fixture table below, so adding a provider without a
 * no-double-count fixture fails this suite rather than silently escaping the invariant.
 *
 * A failing assertion is a REAL finding (a residual double-count), NOT a test to relax.
 */
import { REGISTRY } from '../index';
import type { ProviderFixture } from './conformance';
import type { ProviderModule } from './types';

import { anthropicModule } from '../anthropic/index';
import { openaiModule } from '../openai/index';
import { googleGeminiModule } from '../google-gemini/index';
import { vertexModule } from '../vertex/index';
import { openRouterModule } from '../openrouter/index';
import { bedrockModule } from '../bedrock/index';
import { novitaModule } from '../novita/index';
import { moonshotModule } from '../moonshot/index';
import { azureModule } from '../azure/index';

import openaiPlain from '../openai/__fixtures__/plain.json';
import openaiReasoning from '../openai/__fixtures__/reasoning.json';
import anthropicReasoning from '../anthropic/__fixtures__/reasoning.json';
import googlePlain from '../google-gemini/__fixtures__/plain.json';
import vertexPlain from '../vertex/__fixtures__/plain.json';
import openrouterReasoning from '../openrouter/__fixtures__/reasoning.json';
import bedrockPlain from '../bedrock/__fixtures__/plain.json';
import novitaPlain from '../novita/__fixtures__/plain.json';
import moonshotPlain from '../moonshot/__fixtures__/plain.json';
import azurePlain from '../azure/__fixtures__/plain.json';

interface ProviderCase {
    module: ProviderModule;
    /** A representative model id (for the capability ↔ behavior tie-in). */
    model: string;
    fixtures: Array<{ name: string; fixture: ProviderFixture }>;
}

const CASES: ProviderCase[] = [
    {
        module: openaiModule,
        model: 'o3',
        fixtures: [
            { name: 'plain', fixture: openaiPlain as ProviderFixture },
            { name: 'reasoning', fixture: openaiReasoning as ProviderFixture },
        ],
    },
    {
        module: anthropicModule,
        model: 'claude-sonnet-4-5-20250929',
        fixtures: [
            {
                name: 'reasoning',
                fixture: anthropicReasoning as ProviderFixture,
            },
        ],
    },
    {
        module: googleGeminiModule,
        model: 'gemini-2.5-flash',
        fixtures: [{ name: 'plain', fixture: googlePlain as ProviderFixture }],
    },
    {
        module: vertexModule,
        model: 'gemini-2.5-flash',
        fixtures: [{ name: 'plain', fixture: vertexPlain as ProviderFixture }],
    },
    {
        module: openRouterModule,
        model: 'moonshotai/kimi-k2-thinking',
        fixtures: [
            {
                name: 'reasoning',
                fixture: openrouterReasoning as ProviderFixture,
            },
        ],
    },
    {
        module: bedrockModule,
        model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
        fixtures: [{ name: 'plain', fixture: bedrockPlain as ProviderFixture }],
    },
    {
        module: novitaModule,
        model: 'meta-llama/llama-3.1-70b-instruct',
        fixtures: [{ name: 'plain', fixture: novitaPlain as ProviderFixture }],
    },
    {
        module: moonshotModule,
        model: 'kimi-k2.7-code',
        fixtures: [{ name: 'plain', fixture: moonshotPlain as ProviderFixture }],
    },
    {
        module: azureModule,
        model: 'gpt-4o',
        fixtures: [{ name: 'plain', fixture: azurePlain as ProviderFixture }],
    },
];

/** The aggregate's documented rule (monthly-spend.use-case.ts:126-129). */
const aggregateTotal = (input: number, output: number) => input + output;

describe('provider conformance: registry coverage (no provider escapes the invariant)', () => {
    it('every registered module has a no-double-count fixture case', () => {
        const registered = new Set(REGISTRY.all().map((m) => m.id));
        const covered = new Set(CASES.map((c) => c.module.id));
        // Any registered module missing from CASES → the invariant is unproven for it.
        expect([...registered].sort()).toEqual([...covered].sort());
    });
});

describe.each(CASES)(
    'no reasoning double-count: $module.id.normalizeUsage',
    ({ module, model, fixtures }) => {
        it.each(fixtures)(
            '$name fixture: output is the full completion count; reasoning is a subset, not added on top',
            ({ fixture }) => {
                const usage = module.normalizeUsage({ usage: fixture.usage });
                const expectedReasoning =
                    fixture.usage.outputTokenDetails?.reasoningTokens ??
                    fixture.usage.reasoningTokens ??
                    0;

                // input/output are the RAW recorded counts.
                expect(usage.input).toBe(fixture.usage.inputTokens ?? 0);
                expect(usage.output).toBe(fixture.usage.outputTokens ?? 0);

                // reasoning is always a number (never null/undefined — the
                // observability `reasoning_tokens > 0` guard depends on it).
                expect(typeof usage.reasoning).toBe('number');
                expect(usage.reasoning).toBe(expectedReasoning);

                // THE double-count trap: output already accounts for reasoning, so
                // reasoning is a subset (<= output) and output is NOT reasoning-inflated.
                expect(usage.reasoning).toBeLessThanOrEqual(usage.output);
                if (usage.reasoning > 0) {
                    expect(usage.output).not.toBe(
                        (fixture.usage.outputTokens ?? 0) + usage.reasoning,
                    );
                }
            },
        );

        it.each(fixtures)(
            '$name fixture: aggregate total = input + output matches recorded total (no reasoning added on top)',
            ({ fixture }) => {
                const usage = module.normalizeUsage({ usage: fixture.usage });
                const total = aggregateTotal(usage.input, usage.output);

                // The recorded provider total already equals input + output.
                if (fixture.usage.totalTokens != null) {
                    expect(fixture.usage.totalTokens).toBe(total);
                }

                // A reasoning-added-on-top aggregate would inflate spend; assert the
                // aggregate rule does NOT do that when reasoning is present.
                if (usage.reasoning > 0) {
                    expect(total).not.toBe(
                        usage.input + usage.output + usage.reasoning,
                    );
                }
            },
        );

        it('declares a known usageGranularity, and non-thinking (plain) fixtures surface no reasoning', () => {
            const granularity = module.capabilities(model).usageGranularity;
            // Descriptor sanity — one of the known values.
            expect(['reasoning_split', 'output_only', undefined]).toContain(
                granularity,
            );
            // A non-thinking call never reports a reasoning split, regardless of the
            // descriptor. (The descriptor is a per-provider default: OpenRouter
            // declares 'output_only' yet proxies upstreams that DO surface a split on
            // thinking calls, which normalizeUsage still reads — proven by the
            // per-fixture assertions above. Anthropic's own output_only⇒reasoning-0
            // native-folding case is locked by anthropic.module.spec.ts.)
            for (const { name, fixture } of fixtures) {
                if (name !== 'plain') continue;
                const usage = module.normalizeUsage({ usage: fixture.usage });
                expect(usage.reasoning).toBe(0);
            }
        });
    },
);
