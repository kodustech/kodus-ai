// 04b-06: the legacy {main,fallback} branch is GONE — resolveAgentModel is
// native and always routes through resolveTaskModel (the runtime fallback was
// removed in 04b-05, so it resolves ONE model). This byok-to-vercel mock is kept
// only so the fallback-not-built assertion can inspect the (now-unused) seam.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    buildModelFromSlot: jest.fn(
        (slot: any) => ({ tag: slot ? 'model:main' : 'model:default' }) as any,
    ),
    getModelName: jest.fn(() => 'default:model'),
}));

// v2 path (slice 04b): the codeReview MAIN model resolves through the single
// task→model entry point, now owned by the permission service
// (permissionService.resolveTaskModel(org, task, opts)). This mock IS that
// method (wired into the permission-service stubs below), so we assert
// model-factory delegates the routing decision (task + override ctx) and maps
// the returned slot onto AgentModelParams rather than re-implementing routing.
const resolveTaskModelMock = jest.fn();

import { resolveAgentModel } from './model-factory';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

// The v2 raw accessor returns null (no BYOK) → resolveTaskModel(null) yields the
// env/managed default. getBYOKConfig is retained only to assert it is NEVER
// consulted (the collapsed accessor was removed in 04b-06).
function permissionServiceReturning(byokConfig: any) {
    return {
        getBYOKConfig: jest.fn().mockResolvedValue(byokConfig),
        resolveTaskModel: resolveTaskModelMock,
    } as any;
}

// v2 raw accessor returns the full config blob; the collapsed accessor must NOT be
// consulted on the branch (routing is by task, not always main).
function permissionServiceReturningV2(v2Config: any) {
    return {
        getBYOKConfig: jest
            .fn()
            .mockRejectedValue(
                new Error('getBYOKConfig must not run on the branch'),
            ),
        resolveTaskModel: resolveTaskModelMock,
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

    describe('no BYOK config (null v2 raw) → env/managed default', () => {
        it('routes through resolveTaskModel(null) and carries no byokConfig', async () => {
            resolveTaskModelMock.mockReturnValue({
                model: { tag: 'env-default' },
                modelName: 'default:model',
                slot: null,
                verdict: null,
            });
            const svc = permissionServiceReturning(null);

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // resolveTaskModel is the SOLE path now — called with the org + task;
            // no BYOK → it returns the env/managed default.
            expect(resolveTaskModelMock).toHaveBeenCalledTimes(1);
            expect(resolveTaskModelMock.mock.calls[0][0]).toBe(orgTeam);
            expect(resolveTaskModelMock.mock.calls[0][1]).toBe('codeReview');
            expect(resolved.main.role).toBe('main');
            expect(resolved.main.model).toEqual({ tag: 'env-default' });
            expect(resolved.main.byokProvider).toBeUndefined();
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved).not.toHaveProperty('fallback');
            // The removed collapsed accessor is NEVER consulted.
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('passes a per-repo byokModel NAME override into resolveTaskModel ctx', async () => {
            resolveTaskModelMock.mockReturnValue({
                model: { tag: 'env-default' },
                modelName: 'default:model',
                slot: null,
                verdict: null,
            });
            const svc = permissionServiceReturning(null);

            await resolveAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModel: '  gpt-override  ',
                },
                svc,
            );

            expect(resolveTaskModelMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'gpt-override' },
            });
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
            const [passedOrg, task, opts] = resolveTaskModelMock.mock.calls[0];
            expect(passedOrg).toBe(orgTeam);
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
