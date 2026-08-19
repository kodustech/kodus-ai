// resolveReviewAgentModel routes the codeReview MAIN model through the single
// task→SLOT entry point owned by the permission service
// (permissionService.resolveTaskSlot(org, task, opts)) and maps the returned slot
// onto AgentModelParams. It no longer BUILDS a model — LLM.run does that from the
// slot at call time. So the mock is `resolveTaskSlot` (returns the slot), and we
// assert the routing delegation (task + override ctx) + the slot→params mapping.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    getModelName: jest.fn((slot: any, override?: string) =>
        slot ? `${slot.provider}:${slot.model}` : (override ?? 'default:model'),
    ),
}));

const resolveTaskSlotMock = jest.fn();

import { resolveReviewAgentModel } from './model-factory';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

// getBYOKConfig is retained only to assert it is NEVER consulted (routing is by
// task through resolveTaskSlot, not the collapsed accessor).
function permissionServiceReturning(byokConfig: any) {
    return {
        getBYOKConfig: jest.fn().mockResolvedValue(byokConfig),
        resolveTaskSlot: resolveTaskSlotMock,
    } as any;
}

function permissionServiceReturningV2(_v2Config: any) {
    return {
        getBYOKConfig: jest
            .fn()
            .mockRejectedValue(
                new Error('getBYOKConfig must not run on the branch'),
            ),
        resolveTaskSlot: resolveTaskSlotMock,
    } as any;
}

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

// A sentinel routed openai SLOT (what resolveTaskSlot returns now — no built model).
function routedSlot(overrides: any = {}) {
    return {
        provider: 'openai',
        model: 'gpt-5-mini',
        apiKey: 'enc-oa',
        maxInputTokens: 4096,
        reasoningEffort: 'high',
        reasoningConfigOverride: 'cfg-x',
        ...overrides,
    };
}

describe('resolveReviewAgentModel', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('no BYOK config (null v2 raw) → env/managed default', () => {
        it('routes through resolveTaskSlot(null) and carries no byokConfig', async () => {
            resolveTaskSlotMock.mockReturnValue(undefined);
            const svc = permissionServiceReturning(null);

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolveTaskSlotMock).toHaveBeenCalledTimes(1);
            expect(resolveTaskSlotMock.mock.calls[0][0]).toBe(orgTeam);
            expect(resolveTaskSlotMock.mock.calls[0][1]).toBe('codeReview');
            expect(resolved.main.role).toBe('main');
            expect(resolved.main.modelName).toBe('default:model');
            expect(resolved.main.byokProvider).toBeUndefined();
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved).not.toHaveProperty('fallback');
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('passes a per-repo byokModel NAME override into resolveTaskSlot ctx', async () => {
            resolveTaskSlotMock.mockReturnValue(undefined);
            const svc = permissionServiceReturning(null);

            await resolveReviewAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModel: '  gpt-override  ',
                },
                svc,
            );

            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'gpt-override' },
            });
        });
    });

    describe('v2 configs (MAIN routed via resolveTaskSlot)', () => {
        it('routes the codeReview task through resolveTaskSlot with the id override in ctx', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam, byokModelId: 'm-B' },
                svc,
            );

            expect(resolveTaskSlotMock).toHaveBeenCalledTimes(1);
            const [passedOrg, task, opts] = resolveTaskSlotMock.mock.calls[0];
            expect(passedOrg).toBe(orgTeam);
            expect(task).toBe('codeReview');
            expect(opts.ctx).toEqual({ override: { modelId: 'm-B' } });
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('lets byokModelId (id) win over the legacy byokModel NAME in the override ctx', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveReviewAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModelId: 'm-B',
                    byokModel: 'gpt-4o',
                },
                svc,
            );

            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'm-B' },
            });
        });

        it('passes the legacy byokModel NAME as the override when no id is set (window)', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam, byokModel: 'gpt-5-mini' },
                svc,
            );

            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({
                override: { modelId: 'gpt-5-mini' },
            });
        });

        it('builds the MAIN bundle from the routed slot (modelName + tuning fields)', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.main.role).toBe('main');
            expect(resolved.main.modelName).toBe('openai:gpt-5-mini');
            expect(resolved.main.byokProvider).toBe('openai');
            expect(resolved.main.maxInputTokens).toBe(4096);
            expect(resolved.main.reasoningEffort).toBe('high');
            expect(resolved.main.reasoningConfigOverride).toBe('cfg-x');
            expect(resolved.byokConfig).toEqual(routedSlot());
            // No per-run override → empty ctx.
            expect(resolveTaskSlotMock.mock.calls[0][2].ctx).toEqual({});
        });

        it('ignores routing.fallbackModelId — no fallback slot is resolved', async () => {
            resolveTaskSlotMock.mockReturnValue(routedSlot());
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-B' }),
            );

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // ONE slot resolution, no fallback branch.
            expect(resolveTaskSlotMock).toHaveBeenCalledTimes(1);
            expect(resolved).not.toHaveProperty('fallback');
        });

        it('degrades to the env/managed default (no byokConfig) on a null-slot verdict', async () => {
            resolveTaskSlotMock.mockReturnValue(undefined);
            const svc = permissionServiceReturningV2(v2({ defaultModelId: 'm-A' }));

            const resolved = await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.main.modelName).toBe('default:model');
            expect(resolved.main.byokProvider).toBeUndefined();
            expect(resolved).not.toHaveProperty('fallback');
        });
    });
});
