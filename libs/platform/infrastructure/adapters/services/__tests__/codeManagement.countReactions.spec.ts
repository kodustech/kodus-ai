import { CodeManagementService } from '../codeManagement.service';
import { PlatformIntegrationFactory } from '../platformIntegration.factory';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ICodeManagementService } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

describe('CodeManagementService – countReactions & getPullRequestReviewComment', () => {
    let service: CodeManagementService;
    let integrationService: { findOne: jest.Mock };
    let factory: PlatformIntegrationFactory;
    let mockPlatformService: jest.Mocked<
        Pick<
            ICodeManagementService,
            'countReactions' | 'getPullRequestReviewComment'
        >
    >;

    const orgAndTeam = {
        organizationId: 'org-001',
        teamId: 'team-001',
    };

    beforeEach(() => {
        integrationService = { findOne: jest.fn() };
        factory = new PlatformIntegrationFactory();

        mockPlatformService = {
            countReactions: jest.fn().mockResolvedValue([
                {
                    reactions: { thumbsUp: 1, thumbsDown: 0 },
                    comment: { id: 10 },
                    pullRequest: { id: 'pr-1', number: 1 },
                },
            ]),
            getPullRequestReviewComment: jest
                .fn()
                .mockResolvedValue([{ id: 10, body: 'comment' }]),
        };

        service = new CodeManagementService(integrationService as any, factory);
    });

    describe('countReactions', () => {
        it('should resolve integration type and delegate to the platform service', async () => {
            integrationService.findOne.mockResolvedValue({
                platform: PlatformType.GITHUB,
            });
            factory.registerCodeManagementService(
                PlatformType.GITHUB,
                mockPlatformService as unknown as ICodeManagementService,
            );

            const params = {
                organizationAndTeamData: orgAndTeam,
                comments: [{ id: 10 }],
                pr: { pull_number: 1, repository: { id: 'repo-1' } },
            };

            const result = await service.countReactions(params);

            expect(integrationService.findOne).toHaveBeenCalled();
            expect(mockPlatformService.countReactions).toHaveBeenCalledWith(
                params,
            );
            expect(result).toHaveLength(1);
        });

        it('should handle null integration type gracefully instead of throwing', async () => {
            // BUG: getTypeIntegration returns null → getCodeManagementService(null) throws
            // Expected behavior: return [] when no integration found
            integrationService.findOne.mockResolvedValue(null);

            const params = {
                organizationAndTeamData: orgAndTeam,
                comments: [{ id: 10 }],
                pr: { pull_number: 1, repository: { id: 'repo-1' } },
            };

            // This test expects graceful handling (return []).
            // It will FAIL on the current buggy code that throws instead.
            const result = await service.countReactions(params);
            expect(result).toEqual([]);
        });

        it.each([
            PlatformType.GITHUB,
            PlatformType.GITLAB,
            PlatformType.BITBUCKET,
            PlatformType.AZURE_REPOS,
        ])(
            'should delegate to the correct service for platform %s',
            async (platform) => {
                factory.registerCodeManagementService(
                    platform,
                    mockPlatformService as unknown as ICodeManagementService,
                );

                const params = {
                    organizationAndTeamData: orgAndTeam,
                    comments: [{ id: 10 }],
                    pr: { pull_number: 1, repository: { id: 'repo-1' } },
                };

                await service.countReactions(params, platform);

                expect(integrationService.findOne).not.toHaveBeenCalled();
                expect(mockPlatformService.countReactions).toHaveBeenCalledWith(
                    params,
                );
            },
        );

        it('should use explicit type without calling getTypeIntegration', async () => {
            factory.registerCodeManagementService(
                PlatformType.GITLAB,
                mockPlatformService as unknown as ICodeManagementService,
            );

            const params = {
                organizationAndTeamData: orgAndTeam,
                comments: [],
                pr: { pull_number: 1, repository: { id: 'repo-1' } },
            };

            await service.countReactions(params, PlatformType.GITLAB);

            expect(integrationService.findOne).not.toHaveBeenCalled();
        });
    });

    describe('getPullRequestReviewComment', () => {
        it('should resolve integration type and delegate to the platform service', async () => {
            integrationService.findOne.mockResolvedValue({
                platform: PlatformType.GITHUB,
            });
            factory.registerCodeManagementService(
                PlatformType.GITHUB,
                mockPlatformService as unknown as ICodeManagementService,
            );

            const params = {
                organizationAndTeamData: orgAndTeam,
                filters: {
                    repository: { id: 'repo-1' },
                    pullRequestNumber: 1,
                },
            };

            const result = await service.getPullRequestReviewComment(params);

            expect(integrationService.findOne).toHaveBeenCalled();
            expect(
                mockPlatformService.getPullRequestReviewComment,
            ).toHaveBeenCalledWith(params);
            expect(result).toHaveLength(1);
        });

        it('should handle null integration type gracefully instead of throwing', async () => {
            // BUG: same as countReactions — no null guard before factory call
            integrationService.findOne.mockResolvedValue(null);

            const params = {
                organizationAndTeamData: orgAndTeam,
                filters: {
                    repository: { id: 'repo-1' },
                    pullRequestNumber: 1,
                },
            };

            // This test expects graceful handling (return []).
            // It will FAIL on the current buggy code that throws instead.
            const result = await service.getPullRequestReviewComment(params);
            expect(result).toEqual([]);
        });

        it('should use explicit type without calling getTypeIntegration', async () => {
            factory.registerCodeManagementService(
                PlatformType.GITHUB,
                mockPlatformService as unknown as ICodeManagementService,
            );

            const params = {
                organizationAndTeamData: orgAndTeam,
                filters: {
                    repository: { id: 'repo-1' },
                    pullRequestNumber: 1,
                },
            };

            await service.getPullRequestReviewComment(
                params,
                PlatformType.GITHUB,
            );

            expect(integrationService.findOne).not.toHaveBeenCalled();
        });
    });
});
