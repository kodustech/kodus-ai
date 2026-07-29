jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(
        (_cfg: any, role: string) => ({ tag: `model:${role}` }) as any,
    ),
    getModelName: jest.fn(() => 'default:model'),
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

    describe('v2 configs (routed by task via StaticTaskStrategy)', () => {
        it('routes the codeReview task to the byokModelId id-override (top of precedence)', async () => {
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A' }),
            );

            await resolveAgentModel(
                { organizationAndTeamData: orgTeam, byokModelId: 'm-B' },
                svc,
            );

            const mainCfg = mainConfigPassedToBuild();
            // id 'm-B' → gpt-5-mini, openai credential, ciphertext preserved.
            expect(mainCfg?.main.model).toBe('gpt-5-mini');
            expect(mainCfg?.main.provider).toBe('openai');
            expect(mainCfg?.main.apiKey).toBe('enc-oa');
            // The collapsed accessor must NOT have been used.
            expect(svc.getBYOKConfig).not.toHaveBeenCalled();
        });

        it('lets byokModelId (id) win over the legacy byokModel NAME', async () => {
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A' }),
            );

            await resolveAgentModel(
                {
                    organizationAndTeamData: orgTeam,
                    byokModelId: 'm-B',
                    byokModel: 'gpt-4o',
                },
                svc,
            );

            // id 'm-B' wins → gpt-5-mini, not the NAME 'gpt-4o'.
            expect(mainConfigPassedToBuild()?.main.model).toBe('gpt-5-mini');
        });

        it('applies the legacy byokModel NAME on a v2 config when no id is set (window)', async () => {
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A' }),
            );

            await resolveAgentModel(
                { organizationAndTeamData: orgTeam, byokModel: 'gpt-5-mini' },
                svc,
            );

            // NAME applied onto the chosen slot (default m-A, openai credential).
            const mainCfg = mainConfigPassedToBuild();
            expect(mainCfg?.main.model).toBe('gpt-5-mini');
            expect(mainCfg?.main.apiKey).toBe('enc-oa');
        });

        it('routes to routing.taskOverrides[codeReview] when no per-run override', async () => {
            const svc = permissionServiceReturningV2(
                v2({
                    taskOverrides: { codeReview: 'm-B' },
                    defaultModelId: 'm-A',
                }),
            );

            await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(mainConfigPassedToBuild()?.main.model).toBe('gpt-5-mini');
        });

        it('materializes the fallback slot from routing.fallbackModelId', async () => {
            const svc = permissionServiceReturningV2(
                v2({ defaultModelId: 'm-A', fallbackModelId: 'm-B' }),
            );

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            expect(mainConfigPassedToBuild()?.main.model).toBe('gpt-4o');
            expect(resolved.fallback).not.toBeNull();
            expect(fallbackConfigPassedToBuild()?.fallback.model).toBe(
                'gpt-5-mini',
            );
        });

        it('degrades to the env/managed default (no byokConfig) on a BLOCKED verdict', async () => {
            const svc = permissionServiceReturningV2(
                v2(
                    { defaultModelId: 'm-ANT' },
                    [{ id: 'm-ANT', credentialId: 'c-an', model: 'claude-3-5' }],
                    [{ id: 'c-an', provider: 'anthropic', apiKey: 'enc-an' }],
                ),
            );

            const resolved = await resolveAgentModel(
                { organizationAndTeamData: orgTeam },
                svc,
            );

            // anthropic → structuredOutput none → ineligible for codeReview, no
            // fallback → BLOCKED → byokConfig undefined (env/managed default).
            expect(resolved.byokConfig).toBeUndefined();
            expect(resolved.fallback).toBeNull();
        });
    });
});
