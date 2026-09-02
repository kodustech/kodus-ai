/**
 * Registry-wide contract: a provider DECLARES its facts. It never inherits them.
 *
 * WHY THIS EXISTS
 * The contract's optional members read like "nice to have", but the fallbacks
 * behind them are not neutral — each one is an ASSERTION about the model that
 * nobody checked:
 *
 *   no `reasoningTraits`        ⇒ NON_REASONING_TRAITS: "this model does not
 *                                 think, and a forced tool_choice is safe"
 *   no `temperaturePolicy`      ⇒ (before this) a static supportsTemperature
 *                                 boolean, answered once for every family the
 *                                 provider hosts — since deleted, so an absent
 *                                 policy now means the permissive default
 *   no `providerOptionsNamespace` ⇒ the user's Custom override goes out
 *                                 unwrapped, and is dropped in silence
 *
 * Every one of those has already been wrong in production. Bedrock answered
 * `supportsTemperature: true` for all of its families, including
 * `global.anthropic.claude-opus-4-7` and `eu.anthropic.claude-opus-4-8` — the
 * generation that rejects temperature with a 400. Azure declared nothing at all.
 *
 * The failure mode is what makes a contract the right instrument: an absent
 * declaration is INVISIBLE. Nothing throws, no test turns red, and the module
 * reads as though it had an opinion. So the registry states the requirement
 * once, here, and a new provider module is covered the day it registers — there
 * is no list to update and nothing to remember.
 *
 * Escape hatch, deliberately narrow: a module may be listed in NOT_APPLICABLE
 * with a written reason. Declining a fact is allowed; declining SILENTLY is not.
 */
// @ts-nocheck
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from '.';
import { resolveTemperaturePolicy } from './kernel/temperature';

/** A model id per registered id, used only to CALL the declarations (never to
 *  build or to reach the network). Picked to be representative of what the
 *  provider actually hosts in production. */
const PROBE_MODEL: Record<string, string> = {
    openai: 'gpt-5.4',
    openai_compatible: 'deepseek-v4-pro',
    anthropic: 'claude-opus-5',
    anthropic_compatible: 'kimi-k2.6',
    google_gemini: 'gemini-3-pro-preview',
    google_vertex: 'gemini-3.7-flash',
    open_router: 'z-ai/glm-5.3',
    amazon_bedrock: 'global.anthropic.claude-opus-4-7',
    novita: 'deepseek/deepseek-v4-pro',
    moonshot: 'kimi-k2.6',
    zai: 'glm-5.2',
    azure: 'gpt-5.4',
};

/** Facts a provider may decline — with the reason written down. Empty today. */
const NOT_APPLICABLE: Record<string, Record<string, string>> = {};

const FACTS = [
    'reasoningTraits',
    'temperaturePolicy',
    'providerOptionsNamespace',
] as const;

describe('every registered provider declares its own facts', () => {
    it('has a probe model for every registered id (the list cannot go stale)', () => {
        // A provider added without a probe model would silently skip every
        // assertion below — the exact shape of the bug this file is about.
        expect(REGISTRY.ids().filter((id) => !PROBE_MODEL[id])).toEqual([]);
    });

    for (const fact of FACTS) {
        it(`${fact}: declared by every provider`, () => {
            const missing = REGISTRY.ids().filter(
                (id) =>
                    !REGISTRY.get(id)[fact] && !NOT_APPLICABLE[id]?.[fact],
            );
            expect(missing).toEqual([]);
        });
    }

    describe('the declarations answer, and answer in the contract vocabulary', () => {
        for (const id of Object.keys(PROBE_MODEL)) {
            it(`${id}`, () => {
                if (!REGISTRY.has(id)) return;
                const mod = REGISTRY.get(id);
                const cfg = { provider: id, model: PROBE_MODEL[id], apiKey: '' };

                const traits = mod.reasoningTraits?.(cfg as any);
                const temp = mod.temperaturePolicy?.(cfg as any);
                const ns = mod.providerOptionsNamespace?.(id, cfg.model);

                expect({
                    id,
                    traitsShape: {
                        thinksByDefault: typeof traits?.thinksByDefault,
                        canDisableThinking: typeof traits?.canDisableThinking,
                        supportsForcedToolChoice:
                            typeof traits?.supportsForcedToolChoice,
                        forcedToolChoiceRejectsThinking:
                            typeof traits?.forcedToolChoiceRejectsThinking,
                    },
                    tempKind: temp?.kind,
                    namespaceIsNonEmptyString:
                        typeof ns === 'string' && ns.length > 0,
                }).toEqual({
                    id,
                    traitsShape: {
                        thinksByDefault: 'boolean',
                        canDisableThinking: 'boolean',
                        supportsForcedToolChoice: 'boolean',
                        forcedToolChoiceRejectsThinking: 'boolean',
                    },
                    // 'adjustable' | 'fixed' | 'unsupported' — never undefined,
                    // which is what sends the caller back to the fallback.
                    tempKind: expect.stringMatching(
                        /^(adjustable|fixed|unsupported)$/,
                    ),
                    namespaceIsNonEmptyString: true,
                });
            });
        }
    });

    it('the resolved policy is the DECLARED policy — no fallback in play', () => {
        // `resolveTemperaturePolicy` still carries a permissive default for a
        // module with no declaration. With the contract above in force it must
        // never be what a caller actually gets; if this ever diverges, some
        // module stopped answering and the default started answering for it.
        const viaFallback = Object.keys(PROBE_MODEL)
            .filter((id) => REGISTRY.has(id))
            .map((id) => {
                const cfg = { provider: id, model: PROBE_MODEL[id], apiKey: '' };
                return {
                    id,
                    resolved: resolveTemperaturePolicy(REGISTRY.get(id), cfg),
                    declared: REGISTRY.get(id).temperaturePolicy?.(cfg),
                };
            })
            .filter(
                (r) =>
                    JSON.stringify(r.resolved) !== JSON.stringify(r.declared),
            );

        expect(viaFallback).toEqual([]);
    });
});
