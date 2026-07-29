// Legacy {main} path builds via buildModelFromSlot/getModelName off the single
// resolved slot. The runtime fallback was removed in 04b-05 — resolveAgentModel
// resolves ONE model.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(
        (slot: any) => ({ tag: slot ? 'model:main' : 'model:default' }) as any,
    ),
    getModelName: jest.fn(() => 'default:model'),
}));

// v2 path (slice 04b): the codeReview MAIN model resolves through the single
// task→model entry point. Mock the seam so we assert model-factory delegates the
// routing decision (and maps the returned slot onto AgentModelParams) rather than
// re-implementing StaticTaskStrategy here.
const resolveTaskModelMock = jest.fn();
jest.mock('@libs/llm/resolve-task-model', () => ({
    resolveTaskModel: (...args: any[]) => resolveTaskModelMock(...args),
}));

import { resolveAgentModel } from './model-factory';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

// Legacy accessor returns {main,fallback}; the v2 raw accessor returns null so
// resolveAgentModel takes the legacy branch.
function permissionServiceReturning(byokConfig: any) {
    return {
        getBYOKConfig: jest.fn().mockResolvedValue(byokConfig),
        getBYOKConfigV2Raw: jest.fn().mockResolvedValue(null),
    } as any;
}

// v2 raw accessor returns the full v2 blob; the collapsed accessor must NOT be
// consulted on the v2 branch (routing is by task, not always main).
function permissionServiceReturningV2(v2Config: any) {
    return {
        getBYOKConfig: jest
            .fn()
            .mockRejectedValue(
                new Error('getBYOKConfig must not run on the v2 branch'),
            ),
        getBYOKConfigV2Raw: jest.fn().mockResolvedValue(v2Config),
    } as any;
}

// openai gpt-* → structuredOutput json_schema (eligible for codeReview).
const v2 = (routing: any, models?: any[], credentials?: any[]) => ({
    version: 2,
    credentials: credentials ?? [
        { id: 'c-oa', provider: 'openai', apiKey: 'enc-oa' },
    ],
    models: models ?? [
        { id: 'm-A', credentialId: 'c-oa', model: 'gpt-4o' },
        { id: 'm-B', credentialId: 'c-oa', model: 'gpt-5-mini' },
    ],
    routing,
});

// The legacy branch hands `buildModelFromSlot` the resolved `main` slot as its
// first arg. Return that slot so the override test can assert `.model`.
function mainSlotPassedToBuild() {
    const {
        buildModelFromSlot,
    } = require('@libs/llm/byok-to-vercel') as {
        buildModelFromSlot: jest.Mock;
    };
    return buildModelFromSlot.mock.calls[0]?.[0];
}

/** No 2nd model is ever built — buildModelFromSlot is never handed a fallback
 *  slot (the legacy fallback carries `provider: 'anthropic'` in these tests). */
function assertNoFallbackModelBuilt() {
    const {
        buildModelFromSlot,
    } = require('@libs/llm/byok-to-vercel') as {
        buildModelFromSlot: jest.Mock;
    };
    expect(
        buildModelFromSlot.mock.calls.some(
            (c: any[]) => c[0]?.provider === 'anthropic',
        ),
    ).toBe(false);
}

// A sentinel resolveTaskModel return for a routed openai slot.
function resolvedRouted(overrides: any = {}) {
    return {
        model: { tag: 'routed-main' },
        modelName: 'openai:gpt-5-mini',
        slot: {
            provider: 'openai',
            model: 'gpt-5-mini',
            apiKey: 'enc-oa',
            maxInputTokens: 4096,
            reasoningEffort: 'high',
            reasoningConfigOverride: 'cfg-x',
        },
        verdict: { modelId: 'm-B', reason: 'resolved' },
        ...overrides,
    };
}

describe('resolveAgentModel', () => {
    beforeEach(() => {
        // mock.calls accumulates across tests; the override test inspects calls
        // by role, so each case must start from a clean slate.
        jest.clearAllMocks();
    });

    describe('legacy {main} configs (single model — no runtime fallback)', () => {
        it('builds a main bundle and carries NO fallback field', async () => {
            const svc = permissionServiceReturning({
                main: {
                    provider: 'openai',
                    model: 'gpt-main',
                    reasoningEffort: 'high',
                },
            });

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.main.role).toBe('main');
            expect(resolved.main.model).toEqual({ tag: 'model:main' });
            expect(resolved.main.reasoningEffort).toBe('high');
            expect(resolved.main.byokProvider).toBe('openai');
            // The runtime fallback is gone: no fallback field, no 2nd model.
            expect(resolved).not.toHaveProperty('fallback');
            assertNoFallbackModelBuilt();
            // The v2 seam is never touched on the legacy branch.
            expect(resolveTaskModelMock).not.toHaveBeenCalled();
        });

        it('ignores a configured fallback provider — resolves main only', async () => {
            const svc = permissionServiceReturning({
                main: { provider: 'openai', model: 'gpt-main' },
                // A legacy blob may still carry a `fallback`; it is NOT resolved.
                fallback: { provider: 'anthropic', model: 'claude-fb' },
            });

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.main.role).toBe('main');
            expect(resolved).not.toHaveProperty('fallback');
            assertNoFallbackModelBuilt();
        });

        it('applies the per-repo byokModel override to main (no fallback build)', async () => {
            const svc = permissionServiceReturning({
                main: { provider: 'openai', model: 'gpt-main' },
                fallback: { provider: 'anthropic', model: 'claude-fb' },
            });

            await resolveAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModel: '  gpt-override  ',
                },
                svc,
            );

            expect(mainSlotPassedToBuild()?.model).toBe('gpt-override');
            assertNoFallbackModelBuilt();
        });
    });

    describe('v2 configs (MAIN routed via resolveTaskModel — slice 04b)', () => {
        it('routes the codeReview task through resolveTaskModel with the id override in ctx', async () => {
            resolveTaskModelMock.mockReturnValue(resolvedRouted());
            const cfg = v2({ defaultModelId: 'm-A' });
            const svc = permissionServiceReturningV2(cfg);

            await resolveAgentModel(
                { organizationAndTeamData: orgTeam, byokModelId: 'm-B' },
                svc,
            );

            expect(resolveTaskModelMock).toHaveBeenCalledTimes(1);
            const [passedCfg, task, opts] = resolveTaskModelMock.mock.calls[0];
            expect(passedCfg).toBe(cfg);
            expect(task).toBe('codeReview');
            expect(opts.ctx).toEqual({ override: { modelId: 'm-B' } });
            // The collapsed accessor must NOT have been used.
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('lets byokModelId (id) win over the legacy byokModel NAME in the override ctx', async () => {
            resolveTaskModelMock.mockReturnValue(resolvedRouted());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModelId: 'm-B',
                    byokModel: 'gpt-4o',
                },
                svc,
            );

            expect(resolveTaskModelMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'm-B' },
            });
        });

        it('passes the legacy byokModel NAME as the override when no id is set (window)', async () => {
            resolveTaskModelMock.mockReturnValue(resolvedRouted());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveAgentModel(
                { organizationAndTeamData: orgTeam, byokModel: 'gpt-5-mini' },
                svc,
            );

            expect(resolveTaskModelMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'gpt-5-mini' },
            });
        });

        it('builds the MAIN bundle from the resolver return (model, modelName, slot fields)', async () => {
            resolveTaskModelMock.mockReturnValue(resolvedRouted());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.main.role).toBe('main');
            expect(resolved.main.model).toEqual({ tag: 'routed-main' });
            expect(resolved.main.modelName).toBe('openai:gpt-5-mini');
            expect(resolved.main.byokProvider).toBe('openai');
            expect(resolved.main.maxInputTokens).toBe(4096);
            expect(resolved.main.reasoningEffort).toBe('high');
            expect(resolved.main.reasoningConfigOverride).toBe('cfg-x');
            // No per-run override → empty ctx.
            expect(resolveTaskModelMock.mock.calls[0][2].ctx).toEqual({});
        });

        it('ignores routing.fallbackModelId — no fallback slot is resolved', async () => {
            resolveTaskModelMock.mockReturnValue(resolvedRouted());
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-B' }),
            );

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved).not.toHaveProperty('fallback');
            assertNoFallbackModelBuilt();
        });

        it('degrades to the env/managed default (no byokConfig) on a null-slot verdict', async () => {
            resolveTaskModelMock.mockReturnValue(
                resolvedRouted({
                    slot: null,
                    modelName: 'default:model',
                    model: { tag: 'env-default' },
                    verdict: { modelId: null, reason: 'BLOCKED' },
                }),
            );
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A' }),
            );

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.main.model).toEqual({ tag: 'env-default' });
            expect(resolved.main.byokProvider).toBeUndefined();
            expect(resolved).not.toHaveProperty('fallback');
        });
    });
});
