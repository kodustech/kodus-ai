/**
 * Registry-wide contract: ONE fact, ONE answer.
 *
 * WHY THIS EXISTS
 * The module contract grew two ways to ask the same question, and the consumers
 * quietly disagreed about which to trust:
 *
 *   runtime (sampling-params.ts)     temperaturePolicy(cfg) ?? { adjustable }
 *   connect form (get-model-caps)    temperaturePolicy(cfg) ?? capabilities().supportsTemperature
 *
 * `openaiModule.temperaturePolicy` returns `undefined` for NATIVE OpenAI on
 * purpose, documented as "the caller derives it from the static capability" —
 * and only one of the two callers actually does. So for gpt-5.x / o-series
 * (26 production slots carry a temperature) the form hides the field while the
 * runtime resolves the stored value and sends it. It does not 400 today only
 * because the AI SDK strips temperature for reasoning models on its way out:
 * our layer decided to send it, luck stopped it.
 *
 * Nothing could have caught that by testing either half. Each half was right.
 *
 * The fallback now lives once, in `kernel/temperature.ts`, so the two rules can
 * no longer drift apart. What this file guards is the layer below: that the
 * runtime HONORS the resolved policy — hidden field ⇒ nothing on the wire,
 * pinned ⇒ the pin, editable ⇒ what the user typed. A future consumer that
 * re-inlines its own fallback breaks these.
 */
// @ts-nocheck
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from '.';
import { resolveByokTemperature } from '../sampling-params';
import { resolveTemperaturePolicy } from './kernel/temperature';

/** Representative models per provider, chosen to hit the constrained cases —
 *  a reasoner that rejects temperature, an always-thinking model that pins it,
 *  and an ordinary one that leaves it free. */
const CASES: Array<{ provider: string; model: string; note: string }> = [
    { provider: 'openai', model: 'gpt-5.4', note: 'native reasoner: rejects temperature' },
    { provider: 'openai', model: 'o3', note: 'o-series reasoner: rejects temperature' },
    { provider: 'openai', model: 'gpt-4o', note: 'ordinary: temperature is free' },
    { provider: 'openai_compatible', model: 'deepseek-v4-pro', note: 'unsupported while thinking' },
    { provider: 'openai_compatible', model: 'glm-5.3', note: 'always-thinking: pinned to 1' },
    { provider: 'openai_compatible', model: 'kimi-k2.6', note: 'disable-able: free' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', note: 'adaptive: rejects temperature' },
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', note: 'legacy: free' },
    { provider: 'anthropic_compatible', model: 'k3', note: 'always-thinking over the anthropic protocol' },
    { provider: 'open_router', model: 'z-ai/glm-5.3', note: 'always-thinking behind an aggregator' },
    { provider: 'google_gemini', model: 'gemini-3-pro-preview', note: 'temperature is free' },
    { provider: 'novita', model: 'deepseek/deepseek-v4-pro', note: 'aggregator' },
    // Managed hosts. The SAME Claude, reached through a different provider id,
    // has to give the SAME answer — these three ids are live in production and
    // all of them used to answer `supportsTemperature: true` for every family
    // they host, `global.anthropic.claude-opus-4-7` included.
    {
        provider: 'amazon_bedrock',
        model: 'global.anthropic.claude-opus-4-7',
        note: 'Claude-on-Bedrock: the 4.7 line rejects temperature',
    },
    {
        provider: 'amazon_bedrock',
        model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        note: 'Claude-on-Bedrock, fully decorated id: 4.5 accepts it',
    },
    {
        provider: 'amazon_bedrock',
        model: 'minimax.minimax-m2',
        note: 'non-Claude family on Bedrock: free',
    },
    {
        provider: 'google_vertex',
        model: 'claude-opus-4-7',
        note: 'Claude-on-Vertex: same model, same answer as native',
    },
    {
        provider: 'google_vertex',
        model: 'gemini-3.7-flash',
        note: 'Gemini-on-Vertex: free',
    },
    { provider: 'azure', model: 'o3-mini', note: 'reasoning deployment: rejects' },
    { provider: 'azure', model: 'gpt-4o', note: 'ordinary deployment: free' },
];

/** The ONE resolved policy — the same call the connect form and the tuning
 *  validator make. Before `kernel/temperature.ts` each of them inlined its own
 *  fallback and they disagreed; this test now guards the layer BELOW that: that
 *  the runtime actually honors whatever the policy says. */
function resolvedPolicy(provider: string, model: string, effort?: string) {
    return resolveTemperaturePolicy(REGISTRY.get(provider), {
        provider,
        model,
        apiKey: '',
        ...(effort ? { reasoningEffort: effort } : {}),
    } as any);
}

/** What the RUNTIME would actually put on the wire for a stored temperature. */
function temperatureTheRuntimeSends(
    provider: string,
    model: string,
    stored: number,
    effort?: string,
) {
    return resolveByokTemperature({
        provider,
        model,
        temperature: stored,
        ...(effort ? { reasoningEffort: effort } : {}),
    } as any);
}

describe('temperature: the form and the runtime must not disagree', () => {
    const STORED = 0.2;

    for (const { provider, model, note } of CASES) {
        it(`${provider}/${model} — ${note}`, () => {
            const shown = resolvedPolicy(provider, model);
            const sent = temperatureTheRuntimeSends(provider, model, STORED);

            // The form's answer IS the promise made to the user. The runtime has
            // to keep it: hidden field ⇒ nothing on the wire; pinned ⇒ the pin;
            // editable ⇒ what they typed.
            const expected =
                shown.kind === 'unsupported'
                    ? undefined
                    : shown.kind === 'fixed'
                      ? shown.value
                      : STORED;

            expect({ provider, model, formSays: shown, runtimeSends: sent }).toEqual({
                provider,
                model,
                formSays: shown,
                runtimeSends: expected,
            });
        });
    }
});
