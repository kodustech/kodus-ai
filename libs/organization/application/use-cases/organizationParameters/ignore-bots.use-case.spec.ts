import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { IgnoreBotsUseCase } from './ignore-bots.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('IgnoreBotsUseCase', () => {
    const params = { organizationId: 'org-1', teamId: 'team-1' };
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const makeUseCase = (overrides?: {
        members?: unknown[];
        prAuthors?: unknown[];
        storedConfig?: unknown;
    }) => {
        // What the stored lists end up holding is the repository's
        // (organizationParameters.repository.merge.integration.spec.ts):
        // here, which lists are seeded and with which bots.
        const organizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(overrides?.storedConfig),
            mergeConfigValue: jest.fn().mockResolvedValue(undefined),
            seedBotIds: jest.fn().mockResolvedValue(undefined),
        };
        const codeManagementService = {
            getListMembers: jest
                .fn()
                .mockResolvedValue(overrides?.members ?? []),
        };
        const pullRequestHandlerService = {
            getPullRequestAuthorsWithCache: jest
                .fn()
                .mockResolvedValue(overrides?.prAuthors ?? []),
        };

        return {
            useCase: new IgnoreBotsUseCase(
                pullRequestHandlerService as any,
                codeManagementService as any,
                organizationParametersService as any,
            ),
            organizationParametersService,
            codeManagementService,
            pullRequestHandlerService,
        };
    };

    it("seeds the bots found among members and PR authors into the organization's lists", async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [
                { id: '1', type: 'user' },
                { id: 'bot-1', type: 'bot' },
            ],
            prAuthors: [{ id: 'bot-pr', type: 'bot' }],
        });

        await useCase.execute(params);

        expect(organizationParametersService.seedBotIds.mock.calls).toEqual([
            [organizationAndTeamData.organizationId, ['bot-1', 'bot-pr'], {}],
        ]);
        expect(
            organizationParametersService.mergeConfigValue,
        ).not.toHaveBeenCalled();
    });

    it('writes nothing when no bot is found', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [{ id: '1', type: 'user' }],
        });

        await useCase.execute(params);

        expect(organizationParametersService.seedBotIds).not.toHaveBeenCalled();
    });

    it("claims a new connection's own empty lists, never overwriting existing ones", async () => {
        const { useCase, organizationParametersService } = makeUseCase();

        await useCase.claimConnectionLists({
            organizationId: 'org-1',
            integrationId: 'gl-b',
        });

        expect(
            organizationParametersService.mergeConfigValue,
        ).toHaveBeenCalledWith(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            'org-1',
            { ignoredUsers: [], allowedUsers: [], seededBotIds: [] },
            { connectionId: 'gl-b', onlyIfAbsent: true },
        );
    });

    describe('per Git connection', () => {
        it("seeds a connection added beside others into that connection's own lists", async () => {
            const { useCase, organizationParametersService } = makeUseCase({
                members: [{ id: 'bot-gl', type: 'bot' }],
                storedConfig: {
                    configValue: { ignoredUsers: ['bot-gh'] },
                },
            });

            await useCase.execute({
                ...params,
                integrationId: 'gl-b',
                separateConnection: true,
            });

            expect(organizationParametersService.seedBotIds.mock.calls).toEqual(
                [['org-1', ['bot-gl'], { connectionId: 'gl-b' }]],
            );
        });

        it('seeds a connection that already has lists of its own into them', async () => {
            const { useCase, organizationParametersService } = makeUseCase({
                members: [{ id: 'bot-new', type: 'bot' }],
                storedConfig: {
                    configValue: {
                        connections: { 'gl-b': { ignoredUsers: ['person'] } },
                    },
                },
            });

            await useCase.execute({ ...params, integrationId: 'gl-b' });

            expect(organizationParametersService.seedBotIds.mock.calls).toEqual(
                [['org-1', ['bot-new'], { connectionId: 'gl-b' }]],
            );
        });

        it("seeds the workspace's first connection into the organization's lists", async () => {
            const { useCase, organizationParametersService } = makeUseCase({
                members: [{ id: 'bot-gh', type: 'bot' }],
            });

            await useCase.execute({ ...params, integrationId: 'gh-a' });

            expect(organizationParametersService.seedBotIds.mock.calls).toEqual(
                [['org-1', ['bot-gh'], {}]],
            );
        });

        it('reads members and PR authors of that connection', async () => {
            const {
                useCase,
                codeManagementService,
                pullRequestHandlerService,
            } = makeUseCase({ members: [] });

            await useCase.execute({
                ...params,
                integrationId: 'gl-b',
                separateConnection: true,
            });

            expect(codeManagementService.getListMembers).toHaveBeenCalledWith({
                organizationAndTeamData: {
                    ...organizationAndTeamData,
                    integrationId: 'gl-b',
                },
                determineBots: true,
            });
            expect(
                pullRequestHandlerService.getPullRequestAuthorsWithCache,
            ).toHaveBeenCalledWith(
                { ...organizationAndTeamData, integrationId: 'gl-b' },
                true,
            );
        });
    });
});
