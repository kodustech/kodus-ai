/**
 * NINTH instance of this layer's recurring defect, caught BEFORE it shipped —
 * and the honest finding is that it has not shipped, which is why the fix here
 * is a guard rather than a behaviour change.
 *
 * "Does this model do strict json_schema" is answered in two places:
 *
 *   capabilities(model).structuredOutput   — model id only
 *   build(cfg).supportsStructuredOutputs   — model id AND baseURL
 *
 * They disagree in BOTH directions, measured:
 *
 *   llama-3-70b @ :8000       declares json_object  builds strict   (baseURL wins)
 *   qwen-72b @ fireworks      declares json_object  builds strict
 *   gpt-4o @ unknown proxy    declares json_schema  builds loose
 *   gpt-5.4 @ unknown gateway declares json_schema  builds loose
 *
 * WHY IT IS NOT A BUG TODAY: nothing branches on the distinction. Every consumer
 * — `planStructuredCall`, `StaticTaskStrategy`, the web capability gate — tests
 * only `=== 'none'`, and 'none' IS derivable from the model alone (it means
 * "structured output goes through forced tool-use", the Anthropic protocol).
 * The json_schema/json_object half is decoration that happens to be wrong.
 *
 * WHY IT CANNOT BE FIXED IN PLACE: the contract is `capabilities(model: string)`.
 * For `openai_compatible` the correct answer depends on the baseURL, which that
 * signature cannot see — and the openai module serves BOTH `openai` and
 * `openai_compatible`, so it cannot even tell which id it is answering for. The
 * module source already notes this. A real fix is a `structuredOutputPolicy(cfg)`
 * sibling to `temperaturePolicy(cfg)`, which takes the whole config for exactly
 * this reason; that is a contract change across every module, so it is a decision
 * to make deliberately rather than a cleanup to slip in.
 *
 * So this file pins the two things that keep the latent trap from becoming the
 * live bug: the distinction stays non-load-bearing, and `build()` stays the
 * authority.
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from '.';
import {
    isNeverDowngradeModel,
    openAiCompatibleHonorsJsonSchema,
} from '../structured-output-gate';
import {
    NON_REASONING_TRAITS,
    planStructuredCall,
} from './kernel/reasoning-traits';

/** What `build()` will actually turn on, by the same expression the module uses. */
const buildsStrictSchema = (model: string, baseURL?: string) =>
    isNeverDowngradeModel(model) || openAiCompatibleHonorsJsonSchema(baseURL);

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
});
