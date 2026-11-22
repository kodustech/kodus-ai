import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { SuggestionService } from './suggestion.service';

/**
 * Marking a suggestion implemented resolves the host thread behind it. The
 * stored id belongs to Kody's own comment, and the GitLab, Bitbucket and Azure
 * adapters hide those from `getPullRequestReviewComments` unless the caller
 * asks for them (#2443). This drives the real call site, so dropping the flag
 * there turns the test red even though the adapter still honors it.
 */
describe('SuggestionService - resolveImplementedSuggestionsOnPlatform', () => {
    const params = {
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: '42', name: 'acme/api' },
        prNumber: 7,
        platformType: PlatformType.GITLAB,
    };

    const makeService = () => {
        const service = Object.create(
            SuggestionService.prototype,
        ) as SuggestionService;
        const codeManagementService = {
            // Mirrors the adapters: Kody's own comment only comes back when
            // the caller asks for it, so a dropped flag shows up as "nothing
            // to resolve" rather than as a comment handed over anyway.
            getPullRequestReviewComments: jest.fn((request: any) =>
                Promise.resolve(
                    request?.includeKodyComments === true
                        ? [
                              {
                                  id: 1001,
                                  threadId: 'disc-kody',
                                  body: '## Code Review Completed! 🔥',
                                  isResolved: false,
                              },
                          ]
                        : [],
                ),
            ),
            markReviewCommentAsResolved: jest.fn().mockResolvedValue({}),
        };
        Object.assign(service as any, {
            logger: { warn: jest.fn(), error: jest.fn() },
            pullRequestService: {
                findByNumberAndRepositoryName: jest.fn().mockResolvedValue({
                    files: [
                        {
                            suggestions: [
                                {
                                    comment: { id: 1001 },
                                    implementationStatus:
                                        ImplementationStatus.IMPLEMENTED,
                                    deliveryStatus: DeliveryStatus.SENT,
                                },
                            ],
                        },
                    ],
                }),
            },
            codeManagementService,
        });
        return { service, codeManagementService };
    };

    it('asks for Kody’s own comments before matching the stored ids', async () => {
        const { service, codeManagementService } = makeService();

        await service.resolveImplementedSuggestionsOnPlatform(params);

        expect(
            codeManagementService.getPullRequestReviewComments,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ includeKodyComments: true, prNumber: 7 }),
        );
    });

    it('resolves the discussion that carries the implemented suggestion', async () => {
        const { service, codeManagementService } = makeService();

        await service.resolveImplementedSuggestionsOnPlatform(params);

        expect(
            codeManagementService.markReviewCommentAsResolved,
        ).toHaveBeenCalledWith(
            expect.objectContaining({ commentId: 'disc-kody' }),
        );
    });
});
