/**
 * resolve-task-invocation.spec.ts — Porta 1 is a pure composition of three
 * already-unit-tested primitives (resolveTaskSlot + resolveModelConfig +
 * agentModelIdentity). We stub all three and assert the COMPOSITION contract:
 *  - the router's slot is the one fed to BOTH the invocation build and the
 *    usage-identity derivation (so usage attributes the model that actually ran);
 *  - `ctx` reaches the router, the rest of the options reach the invocation;
 *  - the returned shape merges invocation + slot + verdict + usageIdentity.
 */
const resolveTaskSlotMock = jest.fn();
const resolveModelConfigMock = jest.fn();
const agentModelIdentityMock = jest.fn();

jest.mock('./resolve-task-model', () => ({
    resolveTaskSlot: (...a: unknown[]) => resolveTaskSlotMock(...a),
}));
jest.mock('./model-invocation', () => ({
    resolveModelConfig: (...a: unknown[]) => resolveModelConfigMock(...a),
}));
jest.mock('./model-identity', () => ({
    agentModelIdentity: (...a: unknown[]) => agentModelIdentityMock(...a),
}));

import { resolveTaskInvocation } from './resolve-task-invocation';

const SLOT = { provider: 'openai', apiKey: 'enc', model: 'gpt-x', byokModelId: 'm1' };
const VERDICT = { modelId: 'm1', reason: 'default' };
const INVOCATION = {
    model: { __model: true },
    modelName: 'openai:gpt-x',
    callOptions: { temperature: 0.4 },
    providerOptions: { openai: { reasoningEffort: 'high' } },
};
const IDENTITY = { model: 'openai:gpt-x', isByok: true, byokModelId: 'm1', credentialId: 'c1' };

describe('resolveTaskInvocation — Porta 1 (router + access + usage, composed once)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        resolveTaskSlotMock.mockReturnValue({ slot: SLOT, verdict: VERDICT });
        resolveModelConfigMock.mockReturnValue(INVOCATION);
        agentModelIdentityMock.mockReturnValue(IDENTITY);
    });

    it('merges invocation + slot + verdict + usageIdentity into one bundle', () => {
        const out = resolveTaskInvocation({ version: 2 } as any, 'codeReview', {
            runName: 'finder',
        });

        expect(out).toEqual({
            ...INVOCATION,
            slot: SLOT,
            verdict: VERDICT,
            usageIdentity: IDENTITY,
        });
    });

    it('routes the task with ctx, and builds the invocation from the routed slot', () => {
        const ctx = { override: { modelId: 'm-B' } };
        resolveTaskInvocation({ version: 2 } as any, 'kodyRulesReview', {
            runName: 'kody',
            organizationId: 'org-1',
            reasoningEffortDefault: 'none',
            ctx,
        });

        // ctx reaches the router...
        expect(resolveTaskSlotMock).toHaveBeenCalledWith(
            { version: 2 },
            'kodyRulesReview',
            { ctx },
        );
        // ...and the SAME resolved slot feeds the invocation, WITHOUT ctx leaking in.
        expect(resolveModelConfigMock).toHaveBeenCalledWith(
            SLOT,
            expect.objectContaining({
                runName: 'kody',
                organizationId: 'org-1',
                reasoningEffortDefault: 'none',
            }),
        );
        expect(resolveModelConfigMock.mock.calls[0][1]).not.toHaveProperty('ctx');
    });

    it('derives usageIdentity from the SAME slot that built the model', () => {
        resolveTaskInvocation(null, 'conversation', { runName: 'conv' });
        expect(agentModelIdentityMock).toHaveBeenCalledWith(SLOT);
    });

    it('pins usageIdentity.model to invocation.modelName so they cannot drift', () => {
        // Bare identity would report a DIFFERENT model than the invocation name
        // (the env-default override case): the two must not disagree.
        agentModelIdentityMock.mockReturnValue({
            ...IDENTITY,
            model: 'env-managed-default',
        });

        const out = resolveTaskInvocation(null, 'codeReview', {
            runName: 'x',
            defaultModelOverride: 'kimi-k2.7-code',
        });

        expect(out.usageIdentity.model).toBe(out.modelName);
        expect(out.usageIdentity.model).toBe(INVOCATION.modelName);
    });

    it('degrades to the env/managed default when the router returns no slot', () => {
        resolveTaskSlotMock.mockReturnValue({ slot: undefined, verdict: undefined });
        agentModelIdentityMock.mockReturnValue({
            model: 'managed-default',
            isByok: false,
            byokModelId: undefined,
            credentialId: undefined,
        });

        const out = resolveTaskInvocation(null, 'codeReview', { runName: 'x' });

        expect(resolveModelConfigMock).toHaveBeenCalledWith(
            undefined,
            expect.objectContaining({ runName: 'x' }),
        );
        expect(out.slot).toBeUndefined();
        expect(out.usageIdentity.isByok).toBe(false);
    });
});
