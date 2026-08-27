/**
 * CONTRACT — the default reasoning effort a model gets when its slot leaves
 * `reasoningEffort` unset, across the WHOLE BYOK provider × model matrix.
 *
 * Kodus is BYOK: a user can bring any provider + any model, over a native SDK or
 * a compatible proxy. The guarantee this file pins:
 *
 *   1. A model we CONFIRM reasons by default (Claude adaptive, Kimi/GLM/DeepSeek,
 *      OpenAI reasoners) gets 'medium' — proactive, correct thinking.
 *   2. Everything else — a non-reasoner (gpt-4o), a budget/legacy Claude, an
 *      UNKNOWN compatible upstream (a self-hosted Llama/vLLM, a generic proxy) —
 *      gets `undefined`, so NO `thinking` param is forced onto an endpoint that
 *      might reject it. The caller's own default (usually 'none') then decides.
 *
 * (2) is the load-bearing safety property for BYOK: we never force reasoning onto
 * a model we can't vouch for. The final invariant proves the anchors below are a
 * pure projection of each provider's own `reasoningTraits.thinksByDefault`, so the
 * matrix can't silently drift from the traits.
 */
import { defaultReasoningEffortFor } from './reasoning-options';
import { REGISTRY } from './providers';
import { NON_REASONING_TRAITS } from './providers/kernel/reasoning-traits';
import type { ReasoningEffort } from './reasoning-options';

const slot = (provider: string, model: string) =>
    ({ provider, model, apiKey: '' }) as any;

// The anchored matrix — a human-readable statement of intended behaviour, and a
// regression net if a provider's trait detection breaks (e.g. a bad opus-5 regex).
const MATRIX: Array<[string, string, ReasoningEffort | undefined]> = [
    // Anthropic native: adaptive (4.6 / 5) reasons by default → medium; budget /
    // legacy / haiku do NOT reason unasked → unset.
    ['anthropic', 'claude-opus-5', 'medium'],
    ['anthropic', 'claude-sonnet-4-6', 'medium'],
    ['anthropic', 'claude-opus-4-1', undefined],
    ['anthropic', 'claude-haiku-4-5-20251001', undefined],
    // Anthropic-compatible: the KNOWN thinking families → medium; an UNKNOWN
    // upstream → unset (never force thinking onto a plain Llama/proxy).
    ['anthropic_compatible', 'kimi-k2.6', 'medium'],
    ['anthropic_compatible', 'kimi-k2.7-code', 'medium'],
    ['anthropic_compatible', 'glm-5.2', 'medium'],
    ['anthropic_compatible', 'glm-5.3', 'medium'],
    ['anthropic_compatible', 'deepseek-v4-pro', 'medium'],
    ['anthropic_compatible', 'llama-3-70b', undefined],
    ['anthropic_compatible', 'some-unknown-7b', undefined],
    // Brand modules delegate to the same compatible table.
    ['moonshot', 'kimi-k2.6', 'medium'],
    ['moonshot', 'kimi-k2.7-code', 'medium'],
    ['zai', 'glm-5.2', 'medium'],
    ['zai', 'glm-5.3', 'medium'],
    // OpenAI: the reasoner families (gpt-5 / o-series) → medium; a plain chat
    // model (gpt-4o) → unset.
    ['openai', 'gpt-5.4', 'medium'],
    ['openai', 'o4', 'medium'],
    ['openai', 'gpt-4o', undefined],
    // OpenAI-compatible transport: known Kimi → medium; unknown upstream → unset.
    ['openai_compatible', 'kimi-k2.6', 'medium'],
    ['openai_compatible', 'llama-3-70b', undefined],
    // Gemini: not force-defaulted here (the models auto-manage thinking) → unset.
    ['google_gemini', 'gemini-3-pro', undefined],
    ['google_gemini', 'gemini-2.5-pro', undefined],
    // Claude-on-Vertex: same adaptive family → medium.
    ['google_vertex', 'claude-opus-5', 'medium'],
    ['google_vertex', 'gemini-2.5-pro', undefined],
    // OpenRouter normalizes reasoning itself (reasoning.effort) → we don't force.
    ['open_router', 'anthropic/claude-opus-5', undefined],
    // Novita is an aggregator that applies the family rules: a recognized reasoner
    // (DeepSeek/Kimi/GLM) → medium; a plain hosted model → unset.
    ['novita', 'deepseek-v3', 'medium'],
    ['novita', 'meta-llama/llama-3-70b', undefined],
    ['amazon_bedrock', 'anthropic.claude-sonnet-4-5', undefined],
];

describe('defaultReasoningEffortFor — BYOK matrix contract', () => {
    it.each(MATRIX)('%s / %s → %s', (provider, model, expected) => {
        expect(defaultReasoningEffortFor(slot(provider, model))).toBe(expected);
    });

    it('absent / unknown provider → undefined (never throws)', () => {
        expect(defaultReasoningEffortFor(undefined)).toBeUndefined();
        expect(
            defaultReasoningEffortFor(slot('not-a-provider', 'x')),
        ).toBeUndefined();
        expect(defaultReasoningEffortFor(slot('anthropic', '') as any)).toBeUndefined();
    });

    // INVARIANT — the matrix above is a pure projection of each provider module's
    // own `reasoningTraits.thinksByDefault`: 'medium' iff the model reasons by
    // default, else undefined. So a new model is a data change in ONE place (the
    // traits) and this default follows automatically — never a second edit here.
    it('INVARIANT: default === (thinksByDefault ? medium : undefined) for every row', () => {
        for (const [provider, model] of MATRIX) {
            const mod = REGISTRY.get(provider);
            const traits =
                mod.reasoningTraits?.(slot(provider, model)) ??
                NON_REASONING_TRAITS;
            const expected = traits.thinksByDefault ? 'medium' : undefined;
            expect(defaultReasoningEffortFor(slot(provider, model))).toBe(
                expected,
            );
        }
    });
});
