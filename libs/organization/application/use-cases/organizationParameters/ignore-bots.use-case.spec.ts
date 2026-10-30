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
        const organizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(overrides?.storedConfig),
            createOrUpdateConfig: jest.fn().mockResolvedValue(undefined),
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
        };
    };

    const savedConfig = (service: { createOrUpdateConfig: jest.Mock }) =>
        service.createOrUpdateConfig.mock.calls[0]?.[1];

    it('seeds the ignore list with discovered bots when no config exists yet', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [
                { id: '1', type: 'user' },
                { id: 'bot-1', type: 'bot' },
            ],
        });

        await useCase.execute(params);

        expect(
            organizationParametersService.createOrUpdateConfig,
        ).toHaveBeenCalledWith(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            expect.objectContaining({
                ignoredUsers: ['bot-1'],
                seededBotIds: ['bot-1'],
            }),
            organizationAndTeamData,
        );
    });

    // Bots are seeded into the ignore list automatically, so an admin who
    // wants an app reviewed has to remove it. Re-adding it on the next run
    // would silently undo that and leave the app unreviewable again.
    it('does not re-add a bot the admin removed from the ignore list', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [{ id: 'bot-1', type: 'bot' }],
            storedConfig: {
                configValue: {
                    enabled: false,
                    ignoredUsers: [],
                    seededBotIds: ['bot-1'],
                },
            },
        });

        await useCase.execute(params);

        expect(savedConfig(organizationParametersService).ignoredUsers).toEqual(
            [],
        );
    });

    it('ignores a newly discovered bot that was never seeded before', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [
                { id: 'bot-1', type: 'bot' },
                { id: 'bot-2', type: 'bot' },
            ],
            storedConfig: {
                configValue: {
                    enabled: false,
                    ignoredUsers: [],
                    seededBotIds: ['bot-1'],
                },
            },
        });

        await useCase.execute(params);

        const saved = savedConfig(organizationParametersService);
        expect(saved.ignoredUsers).toEqual(['bot-2']);
        expect(saved.seededBotIds).toEqual(
            expect.arrayContaining(['bot-1', 'bot-2']),
        );
    });

    it('treats a pre-existing config with no seeded record as never seeded', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [{ id: 'bot-1', type: 'bot' }],
            storedConfig: {
                configValue: { enabled: false, ignoredUsers: [] },
            },
        });

        await useCase.execute(params);

        expect(savedConfig(organizationParametersService).ignoredUsers).toEqual(
            ['bot-1'],
        );
    });

    it('keeps entries the admin added by hand', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [{ id: 'bot-1', type: 'bot' }],
            storedConfig: {
                configValue: {
                    enabled: false,
                    ignoredUsers: ['a-human'],
                    seededBotIds: [],
                },
            },
        });

        await useCase.execute(params);

        expect(savedConfig(organizationParametersService).ignoredUsers).toEqual(
            expect.arrayContaining(['a-human', 'bot-1']),
        );
    });

    it('collects bots from pull request authors as well as members', async () => {
        const { useCase, organizationParametersService } = makeUseCase({
            members: [{ id: 'human', type: 'user' }],
            prAuthors: [{ id: 'bot-pr', type: 'bot' }],
        });

        await useCase.execute(params);

        expect(savedConfig(organizationParametersService).ignoredUsers).toEqual(
            ['bot-pr'],
        );
    });
});
