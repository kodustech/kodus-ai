jest.mock('@libs/llm/byok-to-vercel', () => ({
    byokToVercelModel: jest.fn(
        (_cfg: any, role: string) => ({ tag: `model:${role}` }) as any,
    ),
    getModelName: jest.fn(() => 'default:model'),
}));

import { resolveAgentModel } from './model-factory';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

function permissionServiceReturning(byokConfig: any) {
    return { getBYOKConfig: jest.fn().mockResolvedValue(byokConfig) } as any;
}

describe('resolveAgentModel', () => {
    beforeEach(() => {
        // mock.calls accumulates across tests; the override test inspects calls
        // by role, so each case must start from a clean slate.
        jest.clearAllMocks();
    });

    it('builds only a main bundle when no fallback is configured', async () => {
        const svc = permissionServiceReturning({
            main: { provider: 'openai', model: 'gpt-main', reasoningEffort: 'high' },
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

        const resolved = await resolveAgentModel(
            { organizationAndTeamData: orgTeam, byokModel: '  gpt-override  ' },
            svc,
        );

        // The override reached the config passed for main resolution.
        const {
            byokToVercelModel,
        } = require('@libs/llm/byok-to-vercel') as { byokToVercelModel: jest.Mock };
        const mainCall = byokToVercelModel.mock.calls.find(
            (c: any[]) => c[1] === 'main',
        );
        const fallbackCall = byokToVercelModel.mock.calls.find(
            (c: any[]) => c[1] === 'fallback',
        );
        expect(mainCall?.[0].main.model).toBe('gpt-override');
        expect(fallbackCall?.[0].fallback.model).toBe('claude-fb');
    });
});
