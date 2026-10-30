/**
 * The trait table, checked against the VENDORS' OWN WORDS.
 *
 * WHY THIS FILE
 * Every other spec around these traits asserts that the code does what the code
 * says. That is worth having and it cannot catch the failure that actually
 * happened: a row whose claim was never true, agreed with by its own tests. Two
 * Kimi rows sent a temperature to a model whose vendor documents it as not
 * modifiable, and the specs guarding them asserted exactly that behaviour.
 *
 * So each case here carries the QUOTE and the URL it came from. A trait may
 * change when a vendor changes; it may not change because someone found the test
 * inconvenient, and reading the quote makes the difference obvious.
 *
 * The absences are as load-bearing as the assertions. Where no source covers a
 * model, that is pinned too — inheriting a sibling's rule is how the wrong
 * answers got in, and a test naming the gap turns filling it into an edit to a
 * claim rather than a discovery.
 *
 * Audited 2026-09-02 against the live docs.
 */
import {
    compatibleReasoningConfig,
    compatibleTemperaturePolicy,
    resolveCompatibleReasoningTraits,
} from './reasoning-traits';

describe('DeepSeek — api-docs.deepseek.com/guides/thinking_mode', () => {
    const t = () => resolveCompatibleReasoningTraits('deepseek-v4-pro');

    it('"Thinking mode is enabled by default, with the default effort being high"', () => {
        expect(t().thinksByDefault).toBe(true);
    });

    it('thinking is switchable — `{"thinking": {"type": "enabled/disabled"}}`', () => {
        expect(t().canDisableThinking).toBe(true);
    });

    it('"Thinking mode does not support the temperature, top_p, presence_penalty, or frequency_penalty parameters"', () => {
        // The constraint is on the MODE, not the model — which is why the policy
        // below is effort-scoped and returns a normal temperature once reasoning
        // is explicitly off. Reading it as "this model never takes a temperature"
        // would remove a setting that works.
        expect(t().rejectsSamplingWhileThinking).toBe(true);
        expect(compatibleTemperaturePolicy('deepseek-v4-pro')).toEqual({
            kind: 'unsupported',
        });
        expect(compatibleTemperaturePolicy('deepseek-v4-pro', 'none')).toEqual({
            kind: 'adjustable',
        });
    });

    it('`reasoning_effort` accepted with values low/high/max', () => {
        expect(t().acceptsEffortWithThinking).toBe(true);
        expect(t().effortScale).toBe('low-high-max');
    });

    it('no documented tool_choice restriction', () => {
        expect(t().supportsForcedToolChoice).toBe(true);
    });
});

describe('GLM (Z.ai) — docs.z.ai', () => {
    it('"the default value is auto, and only `auto` is supported" for tool_choice', () => {
        // The least likely-looking claim in the whole table, and exact. It is
        // what makes a structured call reroute to JSON instead of forcing a tool.
        expect(resolveCompatibleReasoningTraits('glm-5.2').supportsForcedToolChoice).toBe(
            false,
        );
    });

    it('thinking is on by default across 4.7 → 5.3, and `{"thinking":{"type":"disabled"}}` turns it off', () => {
        for (const m of ['glm-4.7', 'glm-5.1', 'glm-5.2']) {
            expect(resolveCompatibleReasoningTraits(m).thinksByDefault).toBe(true);
            expect(resolveCompatibleReasoningTraits(m).canDisableThinking).toBe(true);
        }
    });

    it('GLM-5.3 and 5.3-Flash "use forced thinking and cannot be disabled"', () => {
        for (const m of ['glm-5.3', 'glm-5.3-flash']) {
            expect(resolveCompatibleReasoningTraits(m).canDisableThinking).toBe(false);
        }
    });

    it('`reasoning_effort` spans the family (4.6 → 5.3), not just the newest', () => {
        for (const m of ['glm-4.6', 'glm-4.7', 'glm-5.2', 'glm-5.3']) {
            expect(resolveCompatibleReasoningTraits(m).acceptsEffortWithThinking).toBe(
                true,
            );
        }
    });

    it('sampling params keep working while thinking — unlike DeepSeek and Kimi', () => {
        expect(resolveCompatibleReasoningTraits('glm-5.2').rejectsSamplingWhileThinking).toBe(
            false,
        );
        expect(compatibleTemperaturePolicy('glm-5.2')).toEqual({
            kind: 'adjustable',
        });
    });
});

describe('Kimi (Moonshot) — platform.kimi.ai/docs/guide/use-thinking-models', () => {
    it('k2.6: "temperature is not modifiable, so no need to set it"', () => {
        expect(compatibleTemperaturePolicy('kimi-k2.6')).toEqual({
            kind: 'unsupported',
        });
    });

    it('k2.7-code: "temperature is not modifiable and thinking is always on; neither needs to be set"', () => {
        expect(compatibleTemperaturePolicy('kimi-k2.7-code')).toEqual({
            kind: 'unsupported',
        });
        expect(resolveCompatibleReasoningTraits('kimi-k2.7-code').canDisableThinking).toBe(
            false,
        );
    });

    it('k2.6 CAN disable thinking, which says nothing about its temperature', () => {
        // The two facts are independent. Conflating them is what let a
        // documented restriction pass unnoticed for k2.6.
        expect(resolveCompatibleReasoningTraits('kimi-k2.6').canDisableThinking).toBe(true);
    });

    it('k2.x does NOT accept reasoning_effort — the API rejects it alongside thinking', () => {
        // "reasoning_effort Not supported" for K2.x, and HKUDS/nanobot#3939
        // ("Moonshot API rejects kimi-k2.5/k2.6 when reasoning_effort and
        // thinking are both sent") is the live reproduction of what that costs.
        expect(resolveCompatibleReasoningTraits('kimi-k2.6').acceptsEffortWithThinking).toBe(
            false,
        );
    });

    it('k2.5 and k2.7 are NOT on that page, so they keep their temperature', () => {
        // Pinning the absence. Omitting would be the safer guess for them and it
        // would still be a guess.
        for (const m of ['kimi-k2.5', 'kimi-k2.7']) {
            expect(compatibleTemperaturePolicy(m)).toEqual({ kind: 'adjustable' });
        }
    });
});

/**
 * MiniMax runs TWO platforms and production uses both:
 *
 *   api.minimaxi.com/v1        2 slots   (the domain this table's comment cites)
 *   api.minimax.io/v1          2 slots
 *   api.minimax.io/anthropic   2 slots
 *   + OpenRouter, Bedrock, ollama, opencode, nano-gpt
 *
 * Everything below is sourced from platform.minimax.io, which covers the second
 * domain. The minimaxi.com docs could not be read (the page renders client-side),
 * so whether its parameter support differs is UNKNOWN — and the table's own
 * comment cites exactly that unread source for `reasoning_effort`.
 *
 * That gap is left visible rather than papered over. The assertions here are
 * the facts one platform states; none of them claim to speak for the other.
 */
describe('MiniMax — platform.minimax.io/docs/api-reference/text-anthropic-api', () => {
    it('"For M2.x models, thinking cannot be disabled"', () => {
        for (const m of ['MiniMax-M2', 'minimax-m2.5', 'minimax-m2.7']) {
            expect(resolveCompatibleReasoningTraits(m).canDisableThinking).toBe(false);
            expect(resolveCompatibleReasoningTraits(m).thinksByDefault).toBe(true);
        }
    });

    it('temperature range is [0, 2] for all models INCLUDING M2.x — no pin', () => {
        // Closes an incident rather than opening one. A previous version derived
        // the temperature-1 pin from "always reasoning" and applied it to M2,
        // silently overriding the configured value on 18 production slots. The
        // vendor's own range is the evidence that removing it was right, so this
        // is the test that keeps it removed.
        expect(compatibleTemperaturePolicy('MiniMax-M2')).toEqual({
            kind: 'adjustable',
        });
    });

    it('the `effort-only` claim rests on a source we could not read', () => {
        // Recorded as a known-weak leg, not as a verified fact. The table says
        // M2.x is effort-only, citing platform.minimaxi.com; the platform we CAN
        // read documents a `thinking` object for M2.x and does not list
        // `reasoning_effort` at all. Both can be true — they are different
        // platforms — and neither of us has tested the other's endpoint.
        //
        // The practical effect today: on the Anthropic transport M2.x receives no
        // reasoning parameter, and on the OpenAI transport it receives
        // `reasoning_effort`. Since M2.x cannot stop thinking either way, no
        // customer is losing reasoning — only the EFFORT level is uncertain,
        // which is why this is pinned rather than changed.
        expect(resolveCompatibleReasoningTraits('MiniMax-M2').reasoningControl).toBe(
            'effort-only',
        );
    });

    it('M3 is a different model here, and is NOT claimed by the M2 row', () => {
        // "Thinking is off by default for MiniMax-M3 and can be enabled with
        // adaptive" — a different default AND a different shape from M2.x, so
        // the M2 traits must not reach it. What M3 currently receives on the
        // Anthropic protocol is `thinking:{type:enabled,budget_tokens}`; the
        // vendor documents `adaptive`. That difference is NOT asserted either
        // way here, because no source says `enabled` is refused, and guessing a
        // shape is the failure this file exists to prevent.
        expect(resolveCompatibleReasoningTraits('MiniMax-M3').reasoningControl).toBeUndefined();
    });
});

describe('the advertised picker matches the family that owns the model', () => {
    it('offers an effort only where the vendor documents a scale', () => {
        // Kimi is the honest outlier: a toggle, no scale, so one level.
        expect(compatibleReasoningConfig('kimi-k2.6')).toEqual({
            type: 'level',
            options: ['high'],
        });
        for (const m of ['glm-5.2', 'deepseek-v4-pro']) {
            expect(compatibleReasoningConfig(m)).toEqual({
                type: 'level',
                options: ['low', 'medium', 'high'],
            });
        }
    });
});
