import { AgentController } from './agent.controller';

/**
 * Regression coverage for a prod TypeError (BetterStack, 2026-09-16):
 * `teamId` was spliced unconditionally into the thread identifiers while
 * `OrganizationAndTeamDataDto.teamId` is declared `@IsOptional()` — an
 * org-only conversation (or a request omitting `organizationAndTeamData`
 * altogether) crashed with "Cannot read properties of undefined (reading
 * 'teamId')" / a raw `Identificador "teamId" não pode ser... undefined`
 * error, instead of falling back to org(+user) granularity the way `userId`
 * and `conversationId` already do a few lines below.
 */
describe('AgentController.conversation — teamId is optional', () => {
    const makeController = () => {
        const conversationAgentUseCase = { execute: jest.fn().mockResolvedValue('ok') };
        const controller = new AgentController(
            conversationAgentUseCase as any,
            {
                user: {
                    organization: { uuid: 'org-1' },
                    uuid: 'user-1',
                },
            } as any,
        );
        return { controller, conversationAgentUseCase };
    };

    it('does not crash when organizationAndTeamData is missing entirely', async () => {
        const { controller } = makeController();

        await expect(
            controller.conversation({ prompt: 'hi' } as any),
        ).resolves.toBe('ok');
    });

    it('does not crash when organizationAndTeamData.teamId is missing (org-only conversation)', async () => {
        const { controller } = makeController();

        await expect(
            controller.conversation({
                prompt: 'hi',
                organizationAndTeamData: {} as any,
            } as any),
        ).resolves.toBe('ok');
    });

    it('still includes teamId in the thread when it is present', async () => {
        const { controller, conversationAgentUseCase } = makeController();

        await controller.conversation({
            prompt: 'hi',
            organizationAndTeamData: { teamId: 'team-1' } as any,
        } as any);

        const [{ thread }] = conversationAgentUseCase.execute.mock.calls[0];
        // Two calls with/without teamId must hash to different thread ids —
        // otherwise teamId silently stopped affecting thread granularity.
        expect(thread.id).toEqual(expect.any(String));
    });

    it('produces a different thread id with vs. without teamId (still affects granularity)', async () => {
        const { controller: withoutTeam, conversationAgentUseCase: execWithout } =
            makeController();
        const { controller: withTeam, conversationAgentUseCase: execWith } =
            makeController();

        await withoutTeam.conversation({ prompt: 'hi' } as any);
        await withTeam.conversation({
            prompt: 'hi',
            organizationAndTeamData: { teamId: 'team-1' } as any,
        } as any);

        const threadWithout = execWithout.execute.mock.calls[0][0].thread;
        const threadWith = execWith.execute.mock.calls[0][0].thread;
        expect(threadWith.id).not.toBe(threadWithout.id);
    });
});
