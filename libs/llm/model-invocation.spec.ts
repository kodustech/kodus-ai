import { resolveModelConfig } from './model-invocation';
import type { NormalizedModel } from './byok-config';

// The primitive is a pure composition of resolveAgentModel + resolveSlotCallOptions
// + buildProviderOptions. We stub the model build (network-free) and the reasoning
// mapping so the test asserts the COMPOSITION contract — which slot fields flow to
// which primitive — not the internals each dependency already unit-tests.
const buildProviderOptionsMock = jest.fn();

jest.mock('./agent-model', () => ({
    resolveAgentModel: jest.fn(() => ({ __model: true })),
}));
jest.mock('./byok-to-vercel', () => ({
    getModelName: jest.fn((slot?: { provider: string; model: string }) =>
        slot ? `${slot.provider}:${slot.model}` : 'managed-default',
    ),
}));
jest.mock('./reasoning-options', () => ({
    buildProviderOptions: (...args: unknown[]) =>
        buildProviderOptionsMock(...args),
}));

import { resolveAgentModel } from './agent-model';

const slot = (over: Partial<NormalizedModel> = {}): NormalizedModel =>
    ({
        provider: 'openai',
        apiKey: 'enc',
        model: 'gpt-x',
        ...over,
    }) as NormalizedModel;

describe('resolveModelConfig — the single slot → invocation composition', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        buildProviderOptionsMock.mockReturnValue({ some: 'reasoning' });
    });

    it('composes model + name + tuning + reasoning from the slot', () => {
        const inv = resolveModelConfig(
            slot({ temperature: 0.4, maxOutputTokens: 4096 }),
            { runName: 'finder', organizationId: 'org-1' },
        );

        expect(inv.model).toEqual({ __model: true });
        expect(inv.modelName).toBe('openai:gpt-x');
        expect(inv.callOptions).toEqual({
            temperature: 0.4,
            maxOutputTokens: 4096,
        });
        expect(inv.providerOptions).toEqual({ some: 'reasoning' });
    });

    it('forwards org/provider/reporter/modelOptions to resolveAgentModel', () => {
        const reporter = jest.fn();
        resolveModelConfig(slot({ provider: 'anthropic' as any }), {
            runName: 'review',
            organizationId: 'org-2',
            reporter,
            modelOptions: { structuredOutputs: true },
        });

        expect(resolveAgentModel).toHaveBeenCalledWith(
            expect.objectContaining({ provider: 'anthropic' }),
            expect.objectContaining({
                organizationId: 'org-2',
                provider: 'anthropic',
                reporter,
                modelOptions: { structuredOutputs: true },
            }),
        );
    });

    it('honors the slot reasoning fields AND forwards reasoningConfigOverride (the drop the hand-rolled copies made)', () => {
        resolveModelConfig(
            slot({
                reasoningEffort: 'high',
                reasoningConfigOverride: '{"thinking":{"type":"enabled"}}',
            }),
            { runName: 'conv', reasoningEffortDefault: 'low' },
        );

        expect(buildProviderOptionsMock).toHaveBeenCalledWith(
            'conv',
            undefined,
            expect.objectContaining({
                reasoningEffort: 'high', // slot wins over the default
                reasoningConfigOverride: '{"thinking":{"type":"enabled"}}',
                byokProvider: 'openai',
                modelName: 'gpt-x',
            }),
        );
    });

    it("defaults reasoning effort to 'low' when neither the slot nor opts set it", () => {
        resolveModelConfig(slot(), { runName: 'conv' });

        expect(buildProviderOptionsMock).toHaveBeenCalledWith(
            'conv',
            undefined,
            expect.objectContaining({ reasoningEffort: 'low' }),
        );
    });

    it("lets a consumer override the default effort (e.g. 'none' to disable)", () => {
        resolveModelConfig(slot(), {
            runName: 'shard',
            reasoningEffortDefault: 'none',
        });

        expect(buildProviderOptionsMock).toHaveBeenCalledWith(
            'shard',
            undefined,
            expect.objectContaining({ reasoningEffort: 'none' }),
        );
    });

    it('forwards OpenRouter pinning to the reasoning mapping', () => {
        resolveModelConfig(slot({ provider: 'open_router' as any }), {
            runName: 'finder',
            openrouterProviderOrder: ['anthropic', 'openai'],
            openrouterAllowFallbacks: false,
        });

        expect(buildProviderOptionsMock).toHaveBeenCalledWith(
            'finder',
            undefined,
            expect.objectContaining({
                openrouterProviderOrder: ['anthropic', 'openai'],
                openrouterAllowFallbacks: false,
            }),
        );
    });

    it('resolves the env/managed default (empty tuning) for a null slot', () => {
        const inv = resolveModelConfig(null, { runName: 'x' });

        expect(resolveAgentModel).toHaveBeenCalledWith(
            undefined,
            expect.any(Object),
        );
        expect(inv.modelName).toBe('managed-default');
        expect(inv.callOptions).toEqual({});
    });
});
