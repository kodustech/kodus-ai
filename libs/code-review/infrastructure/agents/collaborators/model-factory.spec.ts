// Legacy {main,fallback} path still builds via byokToVercelModel/getModelName.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(
        (_cfg: any, role: string) => ({ tag: `model:${role}` }) as any,
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

function mainConfigPassedToBuild() {
    const {
        byokToVercelModel,
    } = require('@libs/llm/byok-to-vercel') as { byokToVercelModel: jest.Mock };
    return byokToVercelModel.mock.calls.find((c: any[]) => c[1] === 'main')?.[0];
}

function fallbackConfigPassedToBuild() {
    const {
        byokToVercelModel,
    } = require('@libs/llm/byok-to-vercel') as { byokToVercelModel: jest.Mock };
    return byokToVercelModel.mock.calls.find(
        (c: any[]) => c[1] === 'fallback',
    )?.[0];
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

    describe('legacy {main,fallback} configs (unchanged behavior)', () => {
        it('builds only a main bundle when no fallback is configured', async () => {
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
            expect(resolved.fallback).toBeNull();
            // The v2 seam is never touched on the legacy branch.
            expect(resolveTaskModelMock).not.toHaveBeenCalled();
        });

        it('builds a fallback bundle from the configured fallback provider', async () => {
            const svc = permissionServiceReturning({
                main: { provider: 'openai', model: 'gpt-main' },
                fallback: { provider: 'anthropic', model: 'claude-fb' },
            });

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.fallback).not.toBeNull();
            expect(resolved.fallback!.role).toBe('fallback');
            expect(resolved.fallback!.model).toEqual({ tag: 'model:fallback' });
            expect(resolved.fallback!.modelName).toBe('anthropic:claude-fb');
            expect(resolved.fallback!.byokProvider).toBe('anthropic');
        });

        it('applies the per-repo byokModel override to main only, leaving fallback intact', async () => {
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

            expect(mainConfigPassedToBuild()?.main.model).toBe('gpt-override');
            expect(fallbackConfigPassedToBuild()?.fallback.model).toBe(
                'claude-fb',
            );
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

        it('materializes the fallback slot from routing.fallbackModelId (left as-is)', async () => {
            resolveTaskModelMock.mockReturnValue(resolvedRouted());
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-B' }),
            );

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(resolved.fallback).not.toBeNull();
            // fallback is still built via buildRoleParams → byokToVercelModel.
            expect(fallbackConfigPassedToBuild()?.fallback.model).toBe(
                'gpt-5-mini',
            );
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
            expect(resolved.fallback).toBeNull();
        });
    });
});
