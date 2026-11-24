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
 * The expected value is derived from the provider facts, never from a list:
 * the anthropic module reports it when the model has no reasoning config and
 * the compatible traits say thinking cannot be disabled. The one hand-written
 * list below is the pinned result, so a change in traits shows up in review.
 */
import '@libs/llm/providers'; // side-effect: self-register every provider module
import { REGISTRY } from '@libs/llm/providers';
import { anthropicReasoningConfig } from '@libs/llm/providers/anthropic/traits';
import { resolveCompatibleReasoningTraits } from '@libs/llm/providers/kernel/reasoning-traits';
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

const ANTHROPIC_PROTOCOL = new Set(['anthropic', 'anthropic_compatible']);
const BRANDS = new Set(['moonshot', 'zai']);

/** What the provider facts say, read from their sources. */
function expectedAlwaysOn({ provider, model }: ProdShape): boolean {
    return (
        ANTHROPIC_PROTOCOL.has(provider) &&
        !anthropicReasoningConfig(model) &&
        resolveCompatibleReasoningTraits(model).canDisableThinking === false
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

            // Always-on means no level can be sent: the toggle stays locked
            // and the form explains why instead of offering levels.
            if (alwaysOn) {
                expect(caps.supportsReasoning).toBe(false);
                expect(caps.reasoningOptions).toEqual([]);
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
    // GLM-5.3 forces thinking on; the Anthropic-protocol endpoint takes no level.
    'anthropic_compatible GLM-5.3',
    // MiniMax M3 rejects a disable and has no thinking toggle on this wire.
    'anthropic_compatible MiniMax-M3',
    'anthropic_compatible MiniMax-M3.1-Flash',
    'anthropic_compatible glm-5.3',
    'anthropic_compatible glm-5.3-flash',
    'anthropic_compatible internal-glm-5.3-flash',
    'anthropic_compatible minimax-m3',
];
