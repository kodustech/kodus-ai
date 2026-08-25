import { resolveModelConfig } from './model-invocation';
import type { NormalizedModel } from './byok-config';

// The primitive is a pure composition of resolveAgentModel + resolveSlotCallOptions
// + buildProviderOptions. We stub the model build (network-free) and the reasoning
// mapping so the test asserts the COMPOSITION contract — which slot fields flow to
// which primitive — not the internals each dependency already unit-tests.
const buildProviderOptionsMock = jest.fn();
const structuredForcesToolChoiceMock = jest.fn((..._args: unknown[]) => false);

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
    structuredOutputForcesToolChoice: (...args: unknown[]) =>
        structuredForcesToolChoiceMock(...args),
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
        structuredForcesToolChoiceMock.mockReturnValue(false);
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

    describe('thinking ⨯ forced-tool_choice suppression (Anthropic structured output)', () => {
        it('forces reasoning OFF for a STRUCTURED call when the provider forces tool_choice (Kimi/GLM/Claude)', () => {
            // Anthropic protocol: structured output = forced tool_choice, which the
            // API rejects with thinking on. The slot asks for 'medium'; it must be
            // suppressed to 'none' so the review's Kody Rules/dedup/etc. don't 400.
            structuredForcesToolChoiceMock.mockReturnValue(true);

            resolveModelConfig(
                slot({
                    provider: 'moonshot' as any,
                    model: 'kimi-k2.6',
                    reasoningEffort: 'medium',
                    reasoningConfigOverride: '{"thinking":{"type":"enabled"}}',
                }),
                { runName: 'kody-rules', modelOptions: { structuredOutputs: true } },
            );

            expect(structuredForcesToolChoiceMock).toHaveBeenCalledWith(
                'moonshot',
                'kimi-k2.6',
            );
            expect(buildProviderOptionsMock).toHaveBeenCalledWith(
                'kody-rules',
                undefined,
                expect.objectContaining({
                    reasoningEffort: 'none', // suppressed from the slot's 'medium'
                    reasoningConfigOverride: undefined, // override also dropped
                }),
            );
        });

        it('KEEPS the slot reasoning for a NON-structured (agent-loop) call on the same provider', () => {
            // The finder loop uses tool_choice:auto (no structuredOutputs) → thinking
            // is compatible and must stay on.
            structuredForcesToolChoiceMock.mockReturnValue(true);

            resolveModelConfig(
                slot({ provider: 'moonshot' as any, reasoningEffort: 'medium' }),
                { runName: 'finder', modelOptions: {} },
            );

            expect(buildProviderOptionsMock).toHaveBeenCalledWith(
                'finder',
                undefined,
                expect.objectContaining({ reasoningEffort: 'medium' }),
            );
        });

        it('KEEPS the slot reasoning for a structured call when the provider does NOT force tool_choice (OpenAI/Gemini)', () => {
            structuredForcesToolChoiceMock.mockReturnValue(false);

            resolveModelConfig(
                slot({ provider: 'openai' as any, reasoningEffort: 'high' }),
                { runName: 'kody-rules', modelOptions: { structuredOutputs: true } },
            );

            expect(buildProviderOptionsMock).toHaveBeenCalledWith(
                'kody-rules',
                undefined,
                expect.objectContaining({ reasoningEffort: 'high' }),
            );
        });
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
