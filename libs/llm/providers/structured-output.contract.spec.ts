/**
 * NINTH instance of this layer's recurring defect — and it did eventually ship.
 *
 * "Does this model do strict json_schema" was answered in two places:
 *
 *   capabilities(model).structuredOutput   — model id only
 *   build(cfg).supportsStructuredOutputs   — model id AND baseURL
 *
 * They disagreed in BOTH directions, measured:
 *
 *   llama-3-70b @ :8000       declares json_object  builds strict   (baseURL wins)
 *   qwen-72b @ fireworks      declares json_object  builds strict
 *   gpt-4o @ unknown proxy    declares json_schema  builds loose
 *   gpt-5.4 @ unknown gateway declares json_schema  builds loose
 *
 * This file used to say the trap was harmless because nothing branched on the
 * distinction. That held until the cost of NOT branching came due: a call that
 * goes out as bare `json_object` carries no schema and no "json" keyword, so
 * the provider either rejects it outright or the model invents a shape — 460
 * reviews published every duplicate they were meant to deduplicate (#1916).
 *
 * The fix is the third answer this file predicted: `structuredOutputPolicy(cfg)`,
 * a sibling to `temperaturePolicy(cfg)`, taking the whole config so it can see
 * the baseURL and the requested id. It is REQUIRED of every module
 * (declared-facts.contract.spec.ts), `build()` derives its flag from it, and the
 * structured executor branches on it. So this file now pins three things:
 *
 *   - 'none' is still the only half `capabilities(model)` can answer honestly,
 *     and planStructuredCall still reads only that;
 *   - the POLICY and `build()` agree, everywhere, because they are one
 *     expression;
 *   - `capabilities(model)` still disagrees with both — which is FINE, and
 *     documented, as long as nothing branches on it. That is the invariant that
 *     replaces "nobody branches at all".
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from '.';
import { resolveStructuredOutputPolicy } from './kernel/structured-output';
import {
    NON_REASONING_TRAITS,
    planStructuredCall,
} from './kernel/reasoning-traits';

/** What `build()` will actually turn on — read off the BUILT model, not off a
 *  local copy of the module's expression. A copy is what let the two answers
 *  drift in the first place. */
const buildsStrictSchema = (model: string, baseURL?: string) =>
    (
        REGISTRY.get('openai_compatible').build(
            {
                provider: 'openai_compatible',
                model,
                baseURL,
                apiKey: 'k',
            } as any,
            { structuredOutputs: true },
        ) as any
    )?.config?.supportsStructuredOutputs === true;

/** What the module DECLARES this whole config puts on the wire. */
const declaredWire = (model: string, baseURL?: string) =>
    resolveStructuredOutputPolicy(REGISTRY.get('openai_compatible'), {
        provider: 'openai_compatible',
        model,
        baseURL,
        apiKey: 'k',
    } as any);

describe('structured output: only "none" is load-bearing', () => {
    it('planStructuredCall cannot tell json_schema from json_object', () => {
        // The one place the value feeds a decision. If these ever diverge, the
        // declared-vs-built disagreement above stops being harmless and starts
        // choosing a different call shape.
        for (const traits of [
            NON_REASONING_TRAITS,
            {
                thinksByDefault: true,
                canDisableThinking: true,
                supportsForcedToolChoice: true,
                forcedToolChoiceRejectsThinking: true,
            },
            {
                thinksByDefault: true,
                canDisableThinking: false,
                supportsForcedToolChoice: false,
                forcedToolChoiceRejectsThinking: true,
            },
        ]) {
            expect(planStructuredCall('json_schema', traits)).toBe(
                planStructuredCall('json_object', traits),
            );
        }
    });

    it('"none" IS load-bearing, and stays derivable from the model alone', () => {
        // 'none' means "structured output goes through forced tool-use" — the
        // Anthropic protocol — which the model id does determine. This is the
        // half `capabilities(model)` can answer honestly.
        // Observable only where forced tool-use actually constrains the call:
        // a model that thinks by default and rejects a forced tool_choice while
        // thinking. Under NON_REASONING_TRAITS every mode is 'as-is', so that
        // fixture proves nothing here — which the first draft of this test got
        // wrong.
        const thinkingClaude = {
            thinksByDefault: true,
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: true,
        };
        expect(planStructuredCall('none', thinkingClaude)).toBe(
            'suppress-thinking',
        );
        expect(planStructuredCall('json_object', thinkingClaude)).toBe('as-is');
        expect(
            REGISTRY.get('anthropic').capabilities('claude-opus-5')
                .structuredOutput,
        ).toBe('none');
        expect(
            REGISTRY.get('openai_compatible').capabilities('kimi-k2.6')
                .structuredOutput,
        ).not.toBe('none');
    });
});

describe('build() is the authority on strict schema, and it disagrees', () => {
    /** Each row is a real shape: an id plus the endpoint it is served from. */
    const CASES: Array<{ model: string; baseURL: string; why: string }> = [
        {
            model: 'llama-3-70b',
            baseURL: 'http://vllm.internal:8000/v1',
            why: 'vLLM on its default port — the baseURL heuristic enables strict',
        },
        {
            model: 'qwen-72b',
            baseURL: 'https://api.fireworks.ai/inference/v1',
            why: 'Fireworks honors strict schema regardless of the model id',
        },
        {
            model: 'gpt-4o',
            baseURL: 'https://random-proxy.example/v1',
            why: 'an OpenAI-shaped id behind an unvetted proxy is NOT trusted',
        },
    ];

    for (const { model, baseURL, why } of CASES) {
        it(`${model} — ${why}`, () => {
            const declared =
                REGISTRY.get('openai_compatible').capabilities(model)
                    .structuredOutput;
            // Documented, not asserted-equal: they legitimately differ, because
            // only one of the two can see the baseURL. Asserting equality here
            // would be asserting the bug away.
            expect({
                declaredSaysStrict: declared === 'json_schema',
                buildTurnsOnStrict: buildsStrictSchema(model, baseURL),
                // Whatever they say, neither may claim tool-use-only.
                declaredIsNone: declared === 'none',
            }).toMatchObject({ declaredIsNone: false });
        });
    }

    it('the two genuinely disagree — this is the finding, pinned', () => {
        // If this ever goes green-by-agreement, someone unified them and this
        // whole file (and the comment at the top) is stale rather than wrong.
        const disagreements = CASES.filter(({ model, baseURL }) => {
            const declared =
                REGISTRY.get('openai_compatible').capabilities(model)
                    .structuredOutput;
            return (declared === 'json_schema') !== buildsStrictSchema(model, baseURL);
        });
        expect(disagreements.length).toBeGreaterThan(0);
    });

    it('the POLICY does not disagree — it and build() are one expression', () => {
        // This is what makes the branch in the structured executor safe. The
        // executor writes the JSON contract into the prompt exactly when the
        // policy says 'json_object'; if the policy and the body could differ, it
        // would either tax a strict route or leave the broken one bare again.
        const drift = CASES.filter(
            ({ model, baseURL }) =>
                (declaredWire(model, baseURL) === 'json_schema') !==
                buildsStrictSchema(model, baseURL),
        );
        expect(drift).toEqual([]);
    });

    it('every registered module agrees with its own build(), not just these rows', () => {
        // The rows above are openai_compatible shapes. This sweeps the other
        // modules that carry the flag, so a NEW one cannot declare one thing and
        // build another — the recurring defect, caught by the contract instead
        // of by a customer.
        const PROBE: Record<string, { model: string; baseURL?: string }> = {
            openai: { model: 'gpt-5.4' },
            openai_compatible: {
                model: 'deepseek-v4-pro',
                baseURL: 'https://api.deepseek.com/v1',
            },
            open_router: { model: 'z-ai/glm-5.3' },
            novita: { model: 'deepseek/deepseek-v4-pro' },
        };
        const drift = Object.entries(PROBE).filter(([id, { model, baseURL }]) => {
            const cfg = { provider: id, model, baseURL, apiKey: 'k' } as any;
            const built: any = REGISTRY.get(id).build(cfg, {
                structuredOutputs: true,
            });
            const flag = built?.config?.supportsStructuredOutputs;
            if (flag === undefined) return false; // native SDK: no such flag
            return (
                flag !==
                (resolveStructuredOutputPolicy(REGISTRY.get(id), cfg) ===
                    'json_schema')
            );
        });
        expect(drift.map(([id]) => id)).toEqual([]);
    });

    it('a delegating module answers for the upstream it routes over, not for itself', () => {
        // `kodus` bills our own accounts and routes over a real upstream, so its
        // wire answer must come from that upstream WITH the endpoint it will be
        // built against — the same `asUpstream(cfg)` build() uses. Answering for
        // itself would put the contract on a Fireworks call that carries a
        // schema, or leave it off one that does not. (Build is not exercised
        // here: it needs the platform key.)
        expect(
            resolveStructuredOutputPolicy(REGISTRY.get('kodus'), {
                provider: 'kodus',
                model: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
                apiKey: '',
            } as any),
        ).toBe('json_schema');

        // An id the closed catalog cannot price is never routed at all.
        expect(
            resolveStructuredOutputPolicy(REGISTRY.get('kodus'), {
                provider: 'kodus',
                model: 'not-in-the-catalog',
                apiKey: '',
            } as any),
        ).toBe('none');
    });
});
