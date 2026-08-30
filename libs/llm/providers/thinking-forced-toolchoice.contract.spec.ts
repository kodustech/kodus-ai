/**
 * CONTRACT — the per-(provider, model) matrix behind the BYOK reasoning design.
 * For every model we assert the STRUCTURED-call plan (planStructuredCall over the
 * model's capabilities + reasoningTraits) and the reasoning('none') emission.
 *
 * This is the guarantee the design promises: adding a model is a data change, and
 * this table tells you immediately whether it's coherent. The final INVARIANT
 * block fails if ANY model that would issue a forced tool_choice while thinking
 * (and can't disable it) is left on a plan that 400s — nothing ships in silence.
 *
 * Sources: platform.kimi.ai · docs.z.ai · api-docs.deepseek.com · Anthropic/OpenAI/
 * Gemini reasoning docs. Verified live: kodus_worker PR #144–#147.
 */
import { REGISTRY } from './index';
import {
    planStructuredCall,
    NON_REASONING_TRAITS,
    type StructuredCallPlan,
} from './kernel/reasoning-traits';
import { buildReasoningProviderOptions } from '../reasoning-options';

const cfg = (provider: string, model: string) =>
    ({ provider, model, apiKey: '' }) as any;

/** Resolve the structured plan the executor would take for (provider, model). */
function planFor(provider: string, model: string): StructuredCallPlan {
    const mod = REGISTRY.get(provider);
    const traits =
        mod.reasoningTraits?.(cfg(provider, model)) ?? NON_REASONING_TRAITS;
    return planStructuredCall(mod.capabilities(model).structuredOutput, traits);
}

const DISABLED = { anthropic: { thinking: { type: 'disabled' } } };

describe('BYOK reasoning contract — structured plan per (provider, model)', () => {
    describe('suppress-thinking — disable-able, forced-tool_choice, rejects thinking', () => {
        it.each([
            ['moonshot', 'kimi-k2.6'],
            ['moonshot', 'kimi-k2.5'],
            ['anthropic_compatible', 'kimi-k2.6'],
            ['anthropic', 'claude-opus-5'],
            ['anthropic', 'claude-sonnet-5'],
            ['anthropic', 'claude-sonnet-4-5'], // budget: off by default, still suppresses
            ['google_vertex', 'claude-opus-5'],
            ['amazon_bedrock', 'anthropic.claude-sonnet-4-5'],
        ])('%s / %s → suppress-thinking', (p, m) => {
            expect(planFor(p, m)).toBe<StructuredCallPlan>('suppress-thinking');
        });
    });

    describe('reroute-json — always-thinking (no disable) OR no forced-tool_choice (GLM)', () => {
        it.each([
            ['moonshot', 'kimi-k2.7-code'],
            ['moonshot', 'kimi-k3'],
            ['anthropic', 'claude-fable-5'],
            ['anthropic', 'claude-mythos-5'],
            ['zai', 'glm-4.6'], // GLM: tool_choice auto-only → never force
            ['zai', 'glm-4.7'],
            ['zai', 'glm-5.3'], // GLM + always-thinking
        ])('%s / %s → reroute-json', (p, m) => {
            expect(planFor(p, m)).toBe<StructuredCallPlan>('reroute-json');
        });
    });

    describe('as-is — DeepSeek (allows forced tc + thinking) and response_format providers', () => {
        it.each([
            ['anthropic_compatible', 'deepseek-v4-pro'],
            ['openai', 'gpt-5.6'],
            ['openai', 'o4'],
            ['google_gemini', 'gemini-2.5-pro'],
            ['google_vertex', 'gemini-2.5-pro'],
            ['open_router', 'anthropic/claude-opus-5'],
            ['novita', 'deepseek-v3'],
        ])('%s / %s → as-is', (p, m) => {
            expect(planFor(p, m)).toBe<StructuredCallPlan>('as-is');
        });
    });

    describe("reasoning('none') emission — disable-able say it, always-thinking omit it", () => {
        it.each([
            ['moonshot', 'kimi-k2.6'],
            ['zai', 'glm-4.6'],
            ['anthropic', 'claude-opus-5'],
            ['google_vertex', 'claude-opus-5'],
        ])('%s / %s → explicit disabled', (p, m) => {
            expect(buildReasoningProviderOptions(p, 'none', m)).toEqual(
                DISABLED,
            );
        });

        it.each([
            ['moonshot', 'kimi-k2.7-code'],
            ['moonshot', 'kimi-k3'],
            ['anthropic', 'claude-fable-5'],
            ['zai', 'glm-5.3'],
        ])('%s / %s → omit (no thinking param)', (p, m) => {
            expect(buildReasoningProviderOptions(p, 'none', m)).toEqual({});
        });
    });

    // DYNAMIC ids — a user enters a provider + key and picks from the models the
    // provider's /models API returns, which are NOT in our curated catalog. The
    // trait resolver is pattern-based (not catalog-based), so an unknown revision
    // (a future Kimi, a GLM point-release) still resolves to a safe plan the day
    // it ships. This is the P5 guarantee.
    describe('API-listed ids (not curated) resolve to a safe plan', () => {
        it.each([
            // model, expected plan  — over anthropic_compatible (the generic listing transport)
            ['kimi-k3', 'reroute-json'], // always-thinking → reroute
            ['kimi-k2.9-turbo', 'suppress-thinking'], // unknown Kimi, disable-able → suppress
            ['kimi-latest', 'suppress-thinking'],
            ['glm-5.3', 'reroute-json'], // GLM never forces tool_choice
            ['glm-4.9', 'reroute-json'],
            ['deepseek-v4-pro', 'as-is'], // DeepSeek allows forced tc + thinking
            ['some-unknown-upstream-7b', 'suppress-thinking'], // safe default
        ])('anthropic_compatible / %s → %s', (model, expected) => {
            expect(planFor('anthropic_compatible', model)).toBe(expected);
        });
    });

    // The load-bearing INVARIANT: sweep representative models of every reasoning
    // provider — none may land on a plan that would 400 (forced tool_choice while
    // thinking with no way to disable must ALWAYS reroute).
    it('INVARIANT: no model is left on a 400-ing structured plan', () => {
        // Explicit probe per provider — the well-known ids each brand serves (the
        // curated catalog that used to enumerate these is gone; the reasoning
        // TRAITS, not a model list, are what this invariant exercises).
        const PROBE: Record<string, string[]> = {
            anthropic: ['claude-opus-5', 'claude-fable-5'],
            anthropic_compatible: [
                'kimi-k2.6',
                'kimi-k2.7-code',
                'glm-5.2',
                'deepseek-v4-pro',
                'some-unknown-upstream-7b',
            ],
            moonshot: ['kimi-k2.6', 'kimi-k2.7-code'],
            zai: ['glm-5.2'],
        };
        for (const [p, probe] of Object.entries(PROBE)) {
            const mod = REGISTRY.get(p);
            for (const m of probe) {
                const traits =
                    mod.reasoningTraits?.(cfg(p, m)) ?? NON_REASONING_TRAITS;
                const plan = planStructuredCall(
                    mod.capabilities(m).structuredOutput,
                    traits,
                );
                if (
                    traits.forcedToolChoiceRejectsThinking &&
                    !traits.canDisableThinking &&
                    mod.capabilities(m).structuredOutput === 'none'
                ) {
                    expect(plan).toBe('reroute-json');
                }
            }
        }
    });
});
