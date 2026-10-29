// resolveReviewAgentModel routes a review task through the single task→slot
// entry point owned by the permission service
// (permissionService.resolveTaskSlot(org, task, opts)) and maps the returned
// slot onto AgentModelParams. These pin the override precedence, the null-slot
// degrade and that a boundary failure is never swallowed.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    getModelName: jest.fn((slot: any, override?: string) =>
        slot ? `${slot.provider}:${slot.model}` : (override ?? 'default:model'),
    ),
}));

import { resolveReviewAgentModel } from './model-factory';

const orgTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;
const resolveTaskSlot = jest.fn();
const svc = { resolveTaskSlot } as any;

const run = (input: Record<string, unknown> = {}, task?: any) =>
    resolveReviewAgentModel(
        { organizationAndTeamData: orgTeam, ...input } as any,
        svc,
        task,
    );

const overrideCtx = () => resolveTaskSlot.mock.calls[0][2].ctx;

describe('resolveReviewAgentModel', () => {
    beforeEach(() => resolveTaskSlot.mockReset());

    it('routes the codeReview task by default and kodyRulesReview when asked', async () => {
        await run();
        expect(resolveTaskSlot.mock.calls[0][0]).toBe(orgTeam);
        expect(resolveTaskSlot.mock.calls[0][1]).toBe('codeReview');

        resolveTaskSlot.mockReset();
        await run({}, 'kodyRulesReview');
        expect(resolveTaskSlot.mock.calls[0][1]).toBe('kodyRulesReview');
    });

    it('degrades to the env/managed default, with no byokConfig, on a null slot', async () => {
        resolveTaskSlot.mockReturnValue(undefined);

        const resolved = await run();

        expect(resolved.byokConfig).toBeUndefined();
        expect(resolved.main.role).toBe('main');
        expect(resolved.main.modelName).toBe('default:model');
        expect(resolved.main.byokProvider).toBeUndefined();
        expect(resolved).not.toHaveProperty('fallback');
    });

    it('maps a slot onto the declared AgentModelParams (incl. openrouter fields)', async () => {
        const slot = {
            provider: 'open_router',
            model: 'moonshotai/kimi-k2',
            apiKey: 'enc-or',
            maxInputTokens: 128000,
            reasoningEffort: 'medium',
            reasoningConfigOverride: 'cfg-or',
            openrouterProviderOrder: ['moonshotai', 'together'],
            openrouterAllowFallbacks: false,
            temperature: 0.7,
        };
        resolveTaskSlot.mockReturnValue(slot);

        const resolved = await run();

        expect(resolved.main).toEqual({
            role: 'main',
            modelName: 'open_router:moonshotai/kimi-k2',
            maxInputTokens: 128000,
            reasoningEffort: 'medium',
            reasoningConfigOverride: 'cfg-or',
            byokProvider: 'open_router',
            openrouterProviderOrder: ['moonshotai', 'together'],
            openrouterAllowFallbacks: false,
        });
        expect(resolved.byokConfig).toBe(slot);
    });

    describe('per-run model override', () => {
        it('lets byokModelId (id) win over the legacy byokModel NAME', async () => {
            await run({ byokModelId: 'm-B', byokModel: 'gpt-4o' });
            expect(overrideCtx()).toEqual({
                override: { modelId: 'm-B', byId: true },
            });
        });

        it("puts a custom agent's pin over the repository override, which it falls back to", async () => {
            await resolveReviewAgentModel(
                { organizationAndTeamData: orgTeam, byokModelId: 'm-B' } as any,
                svc,
                'customAgent' as any,
                'pin',
            );
            expect(overrideCtx()).toEqual({
                override: {
                    modelId: 'pin',
                    byId: true,
                    then: { modelId: 'm-B', byId: true },
                },
            });
        });

        it('falls back to the trimmed byokModel NAME when no id is set', async () => {
            await run({ byokModel: '  gpt-override  ' });
            expect(overrideCtx()).toEqual({
                override: { modelId: 'gpt-override' },
            });
        });

        it.each([
            ['no override', {}],
            ['blank fields', { byokModel: '', byokModelId: '' }],
            ['whitespace-only name', { byokModel: '   \t\n  ' }],
        ])('sends an empty ctx for %s', async (_label, input) => {
            await run(input);
            expect(overrideCtx()).toEqual({});
        });
    });

    it('propagates a boundary rejection instead of swapping to a default', async () => {
        resolveTaskSlot.mockRejectedValue(new Error('BYOK key suspended'));
        await expect(run()).rejects.toThrow('BYOK key suspended');
    });
});
