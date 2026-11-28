/**
 * `reasoningAlwaysOn` over every production BYOK shape, at the layer the BYOK
 * form reads.
 *
 * The flag means "this model always reasons and no level can be sent for it",
 * and the form turns it into "This model always reasons…" instead of "doesn't
 * support reasoning". The unit specs pinned one model each and passed while the
 * Kimi/GLM brands still leaked the flag next to `supportsReasoning: true`; a
 * sweep over the stored shapes is what found it. So the contract is asserted
 * here for every row of the production corpus, through the same use case the
 * `/model-capabilities` endpoint calls, with the real `ProviderService` (the
 * one that decides which ids are supported).
 *
 * The expected value is derived from the facts, never from a list: the model
 * reasons on every call (its traits), the form offers no level, and the request
 * a slot with no saved level actually builds carries no reasoning field. The
 * one hand-written list below is the pinned result, so a change in traits or
 * in what a transport sends shows up in review.
 */
import '@libs/llm/providers'; // side-effect: self-register every provider module
import { REGISTRY } from '@libs/llm/providers';
import {
    alwaysReasons,
    resolveCompatibleReasoningTraits,
} from '@libs/llm/providers/kernel/reasoning-traits';
import {
    buildProviderOptions,
    defaultReasoningEffortFor,
} from '@libs/llm/reasoning-options';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import PROD_SHAPES from '@libs/llm/testing/__fixtures__/byok-prod-shapes.json';
import {
    GetModelCapabilitiesUseCase,
    type ModelUiCapabilities,
} from './get-model-capabilities.use-case';
import { CAPABILITY_KINDS } from './get-model-capabilities.kinds.fixture';

// The corpus was read from the cloud, where the `kodus` provider is
// connectable; on a self-hosted build `ProviderService` refuses it.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true, API_DEVELOPMENT_MODE: false },
}));

interface ProdShape {
    provider: string;
    model: string;
}

const BRANDS = new Set(['moonshot', 'zai']);

/** The request a slot with no saved level builds carries no reasoning field:
 *  the runtime decision, read through the same builder the calls use. */
function sendsNoLevel({ provider, model }: ProdShape): boolean {
    const effort =
        defaultReasoningEffortFor({ provider, model } as any) ?? 'none';
    const options = buildProviderOptions('prod-shapes', undefined, {
        reasoningEffort: effort,
        byokProvider: provider,
        modelName: model,
    });
    return !/thinking|reasoning|budget|effort/i.test(JSON.stringify(options));
}

/** What the facts say: reasons on every call and none is sent without a
 *  level; no level offered, or the adaptive-effort levels of the Anthropic
 *  protocol (MiniMax M3.1, #2036 QA). */
function expectedAlwaysOn(row: ProdShape): boolean {
    if (BRANDS.has(row.provider)) return false;
    const traits = resolveCompatibleReasoningTraits(row.model);
    const offersAdaptiveEffort =
        row.provider === 'anthropic_compatible' && !!traits.adaptiveEffort;
    return (
        (!REGISTRY.get(row.provider).capabilities(row.model)
            .supportsReasoning ||
            offersAdaptiveEffort) &&
        alwaysReasons(traits) &&
        sendsNoLevel(row)
    );
}

const rows = PROD_SHAPES as ProdShape[];
const useCase = new GetModelCapabilitiesUseCase(new ProviderService());
const label = (r: ProdShape) => `${r.provider} ${r.model}`;

const answers: Array<{ row: ProdShape; caps: ModelUiCapabilities }> = rows.map(
    (row) => ({ row, caps: useCase.execute(row.provider, row.model) }),
);

describe('GetModelCapabilitiesUseCase over the production BYOK shapes', () => {
    it('reads the whole corpus', () => {
        expect(rows).toHaveLength(733);
    });

    it.each(answers.map((a) => [label(a.row), a] as const))(
        '%s',
        (_name, { row, caps }) => {
            // Absent, never false: the form treats a missing key as "no", and
            // a `false` would be a second spelling of the same answer.
            if (
                Object.prototype.hasOwnProperty.call(caps, 'reasoningAlwaysOn')
            ) {
                expect(caps.reasoningAlwaysOn).toBe(true);
            }
            const alwaysOn = caps.reasoningAlwaysOn === true;

            // Always-on with no reasoning support means no level can be
            // sent: the form explains why instead of offering levels. With
            // support, it offers levels and no Off (MiniMax M3.1).
            if (alwaysOn) {
                expect(caps.reasoningOptions.length > 0).toBe(
                    caps.supportsReasoning,
                );
            }

            // The use case forwards what the provider module says, nothing
            // of its own.
            const moduleFlag =
                REGISTRY.get(row.provider).capabilities(row.model)
                    .reasoningAlwaysOn === true;
            expect(alwaysOn).toBe(moduleFlag);

            // And the module says it exactly when the traits do.
            expect(alwaysOn).toBe(expectedAlwaysOn(row));

            // The Kimi/GLM brands expose reasoning, which the flag contradicts.
            if (BRANDS.has(row.provider)) {
                expect(caps).not.toHaveProperty('reasoningAlwaysOn');
                expect(caps.supportsReasoning).toBe(true);
            }
        },
    );

    it('pins the production shapes that report it', () => {
        const reporting = [
            ...new Set(
                answers
                    .filter((a) => a.caps.reasoningAlwaysOn === true)
                    .map((a) => label(a.row)),
            ),
        ].sort();

        expect(reporting).toEqual(PINNED_ALWAYS_ON);
    });

    // The web form spec renders these objects; this keeps them equal to what
    // the API answers for the production row each one names.
    it.each(Object.entries(CAPABILITY_KINDS))(
        'the %s answer the web spec renders is still the API answer',
        (_kind, { provider, model, caps: pinned }) => {
            expect(
                rows.some((r) => r.provider === provider && r.model === model),
            ).toBe(true);
            const { reasoningOverrideExample: _example, ...caps } = JSON.parse(
                JSON.stringify(useCase.execute(provider, model)),
            );
            expect(caps).toEqual(pinned);
        },
    );
});

/**
 * Every distinct production (provider, model) that reports `reasoningAlwaysOn`.
 * Pinned by hand from the derivation above: a change here means a trait or a
 * reasoning config moved, which deserves a reviewer's eye.
 */
const PINNED_ALWAYS_ON: string[] = [
    // Bedrock sends no reasoning field for a non-Anthropic id, and MiniMax M2
    // and Kimi k3 reason on every call.
    'amazon_bedrock minimax.minimax-m2',
    'amazon_bedrock minimax.minimax-m2.5',
    'amazon_bedrock moonshotai.kimi-k3',
    // MiniMax M3.1 reasons with the field omitted and 400s on a disable
    // (#2036): never Off. On the Anthropic wire its level can be picked
    // (adaptive + effort); on the OpenAI wire none is sent. Plain M3 does not
    // reason unasked, and GLM-5.3 / Kimi k3 on this endpoint are sent a
    // budget.
    'anthropic_compatible MiniMax-M3.1-Flash',
    'openai_compatible MiniMax-M3.1-Flash',
    'openai_compatible minimax-m3.1-flash',
    'openai_compatible minimax-m3.1-flash-free',
    'openai_compatible minimax/minimax-m3.1-flash',
];
