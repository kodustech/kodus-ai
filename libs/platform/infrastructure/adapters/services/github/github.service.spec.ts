import { ConfigService } from '@nestjs/config';

import { IntegrationConfigKey, PlatformType } from '@libs/core/domain/enums';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { GithubService } from './github.service';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';

describe('GithubService', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const previousRepositories = [
        { id: '1', name: 'repo-one' },
        { id: '2', name: 'repo-two' },
    ];
    const nextRepositories = [{ id: '2', name: 'repo-two' }];

    const integration = {
        uuid: 'integration-1',
        platform: PlatformType.GITHUB,
    };

    let integrationService: { findOne: jest.Mock };
    let authIntegrationService: Record<string, never>;
    let integrationConfigService: { createOrUpdateConfig: jest.Mock };
    let cacheService: Record<string, never>;
    let configService: ConfigService;
    let service: GithubService;

    beforeEach(() => {
        integrationService = {
            findOne: jest.fn().mockResolvedValue(integration),
        };

        authIntegrationService = {};

        integrationConfigService = {
            createOrUpdateConfig: jest.fn().mockResolvedValue({
                configValue: nextRepositories,
            }),
        };

        cacheService = {};
        configService = {
            get: jest.fn(),
        } as unknown as ConfigService;

        service = new GithubService(
            integrationService as any,
            authIntegrationService as any,
            integrationConfigService as any,
            cacheService as any,
            configService,
        );
    });

    it('returns null when an issue comment cannot be created', async () => {
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            issues: {
                createComment: jest.fn().mockRejectedValue(new Error('denied')),
            },
        });

        await expect(
            service.createIssueComment({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
                body: 'Automatic approval held',
            }),
        ).resolves.toBeNull();
    });

    it('propagates a failed strict comment lookup', async () => {
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            issues: { listComments: jest.fn() },
            paginate: jest
                .fn()
                .mockRejectedValue(new Error('GitHub unavailable')),
        });

        await expect(
            service.getAllCommentsInPullRequest({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
                failOnError: true,
            }),
        ).rejects.toThrow('GitHub unavailable');
    });

    it.each([
        ['the PR has no reviews', []],
        [
            'the PR has only other reviewers',
            [{ user: { login: 'someone-else', node_id: 'other-id' } }],
        ],
    ])('reports no Kody review when %s', async (_scenario, reviews) => {
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            paginate: jest.fn().mockResolvedValue(reviews),
            rest: { pulls: { listReviews: jest.fn() } },
        });
        jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
            jest.fn().mockResolvedValue({
                viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
            }),
        );

        await expect(
            service.getReviewStatusByPullRequest({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
            }),
        ).resolves.toBe(PullRequestReviewState.NONE);
    });

    it.each([
        [
            'a comment review after Kody approved',
            ['APPROVED', 'COMMENTED'],
            PullRequestReviewState.APPROVED,
        ],
        [
            'an approval that was dismissed',
            ['DISMISSED', 'COMMENTED'],
            PullRequestReviewState.DISMISSED,
        ],
        [
            'a change request after an approval',
            ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'],
            PullRequestReviewState.CHANGES_REQUESTED,
        ],
        [
            'only comment reviews',
            ['COMMENTED', 'COMMENTED'],
            PullRequestReviewState.COMMENTED,
        ],
    ])('reads Kody state from %s', async (_scenario, states, expected) => {
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            paginate: jest.fn().mockResolvedValue([
                ...states.map((state, index) => ({
                    state,
                    submitted_at: `2026-10-0${index + 1}T00:00:00Z`,
                    user: { login: 'kody-ai[bot]', node_id: 'kody-id' },
                })),
                {
                    state: 'APPROVED',
                    submitted_at: '2026-10-09T00:00:00Z',
                    user: { login: 'reviewer', node_id: 'other-id' },
                },
            ]),
            rest: { pulls: { listReviews: jest.fn() } },
        });
        jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
            jest.fn().mockResolvedValue({
                viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
            }),
        );

        await expect(
            service.getReviewStatusByPullRequest({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
            }),
        ).resolves.toBe(expected);
    });

    it('dismisses only Kody approvals when a later review holds the PR', async () => {
        const dismissReview = jest.fn().mockResolvedValue({});
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            paginate: jest.fn().mockResolvedValue([
                {
                    id: 10,
                    state: 'APPROVED',
                    user: { login: 'kody-ai[bot]', node_id: 'kody-id' },
                },
                {
                    id: 11,
                    state: 'APPROVED',
                    user: { login: 'reviewer', node_id: 'other-id' },
                },
            ]),
            rest: { pulls: { listReviews: jest.fn(), dismissReview } },
        });
        jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
            jest.fn().mockResolvedValue({
                viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
            }),
        );

        await expect(
            service.dismissOwnPullRequestApprovals({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
                reason: 'Sensitive path changed.',
            }),
        ).resolves.toBe(1);
        expect(dismissReview).toHaveBeenCalledWith(
            expect.objectContaining({
                review_id: 10,
                pull_number: 42,
                message: 'Kody held automatic approval after a new review.',
                request: { signal: expect.any(AbortSignal) },
            }),
        );
        expect(dismissReview).toHaveBeenCalledTimes(1);
    });

    describe('isOwnAccount', () => {
        const kody = { login: 'kody-ai[bot]', node_id: 'kody-id', type: 'Bot' };
        const stub = (authMode: AuthMode) => {
            jest.spyOn(
                service as any,
                'getGithubAuthDetails',
            ).mockResolvedValue({
                authMode,
            });
            return jest
                .spyOn(service as any, 'instanceGraphQL')
                .mockResolvedValue(
                    jest.fn().mockResolvedValue({
                        viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
                    }),
                );
        };

        it.each([
            ['the same login and node id', kody, true],
            [
                'the same login on another account',
                { ...kody, node_id: 'x' },
                false,
            ],
            ['another login', { ...kody, login: 'other[bot]' }, false],
        ])('tells Kody by %s', async (_name, account, expected) => {
            stub(AuthMode.OAUTH);

            await expect(
                service.isOwnAccount({ organizationAndTeamData, account }),
            ).resolves.toBe(expected);
        });

        it('takes a person for somebody else without asking GitHub when installed as an App', async () => {
            const instanceGraphQL = stub(AuthMode.OAUTH);

            await expect(
                service.isOwnAccount({
                    organizationAndTeamData,
                    account: { ...kody, type: 'User' },
                }),
            ).resolves.toBe(false);
            expect(instanceGraphQL).not.toHaveBeenCalled();
        });

        it('asks GitHub, with the credentials it already read, who it is acting as', async () => {
            const auth = { authMode: AuthMode.TOKEN };
            const graphql = jest.fn().mockResolvedValue({
                viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
            });
            jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue(
                auth,
            );
            const instanceGraphQL = jest
                .spyOn(service as any, 'instanceGraphQL')
                .mockResolvedValue(graphql);

            await service.isOwnAccount({ organizationAndTeamData, account: kody });

            expect(instanceGraphQL).toHaveBeenCalledWith(
                organizationAndTeamData,
                auth,
            );
            expect(graphql).toHaveBeenCalledWith('query { viewer { login id } }');
        });

        it('checks a person when Kody acts with a personal token', async () => {
            stub(AuthMode.TOKEN);

            await expect(
                service.isOwnAccount({
                    organizationAndTeamData,
                    account: { ...kody, type: 'User' },
                }),
            ).resolves.toBe(true);
        });
    });

    it("withdraws only Kody's live change requests, with the reason given", async () => {
        const dismissReview = jest.fn().mockResolvedValue({});
        const kody = { login: 'kody-ai[bot]', node_id: 'kody-id' };
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            paginate: jest.fn().mockResolvedValue([
                { id: 10, state: 'CHANGES_REQUESTED', user: kody },
                // Already dismissed, an approval and a comment: not touched.
                { id: 11, state: 'DISMISSED', user: kody },
                { id: 12, state: 'APPROVED', user: kody },
                { id: 13, state: 'COMMENTED', user: kody },
                // A person's change request is theirs to withdraw.
                {
                    id: 14,
                    state: 'CHANGES_REQUESTED',
                    user: { login: 'reviewer', node_id: 'other-id' },
                },
                // Same login, another account.
                {
                    id: 15,
                    state: 'CHANGES_REQUESTED',
                    user: { login: 'kody-ai[bot]', node_id: 'other-id' },
                },
            ]),
            rest: { pulls: { listReviews: jest.fn(), dismissReview } },
        });
        jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
            jest.fn().mockResolvedValue({
                viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
            }),
        );

        await expect(
            service.dismissOwnPullRequestChangeRequests({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
                reason: 'The critical findings are resolved.',
            }),
        ).resolves.toBe(1);
        expect(dismissReview).toHaveBeenCalledTimes(1);
        expect(dismissReview).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'kodustech',
                repo: 'kodus',
                pull_number: 42,
                review_id: 10,
                message: 'The critical findings are resolved.',
            }),
        );
    });

    it.each([
        ['dismissOwnPullRequestChangeRequests', 'change request'],
        ['dismissOwnPullRequestApprovals', 'approval'],
    ] as const)('%s names what it could not dismiss without a repository', async (method, what) => {
        await expect(
            service[method]({
                organizationAndTeamData,
                repository: { id: 'repo-1' },
                prNumber: 42,
                reason: 'Resolved.',
            }),
        ).rejects.toThrow(
            `Repository and PR number are required to dismiss ${what}`,
        );
    });

    it('reports a change request the host refused to dismiss', async () => {
        const refused = Object.assign(new Error('Forbidden'), { status: 403 });
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            org: 'kodustech',
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
            paginate: jest.fn().mockResolvedValue([
                {
                    id: 10,
                    state: 'CHANGES_REQUESTED',
                    user: { login: 'kody-ai[bot]', node_id: 'kody-id' },
                },
            ]),
            rest: {
                pulls: {
                    listReviews: jest.fn(),
                    dismissReview: jest.fn().mockRejectedValue(refused),
                },
            },
        });
        jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
            jest.fn().mockResolvedValue({
                viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
            }),
        );

        await expect(
            service.dismissOwnPullRequestChangeRequests({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
                reason: 'Resolved.',
            }),
        ).rejects.toBe(refused);
    });

    it('bounds a stalled GitHub approval dismissal and reports unknown state', async () => {
        jest.useFakeTimers();
        try {
            const dismissReview = jest
                .fn()
                .mockReturnValue(new Promise(() => {}));
            jest.spyOn(
                service as any,
                'getGithubAuthDetails',
            ).mockResolvedValue({
                org: 'kodustech',
            });
            jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue({
                paginate: jest.fn().mockResolvedValue([
                    {
                        id: 10,
                        state: 'APPROVED',
                        user: { login: 'kody-ai[bot]', node_id: 'kody-id' },
                    },
                ]),
                rest: { pulls: { listReviews: jest.fn(), dismissReview } },
            });
            jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
                jest.fn().mockResolvedValue({
                    viewer: { login: 'kody-ai[bot]', id: 'kody-id' },
                }),
            );

            const dismissal = service.dismissOwnPullRequestApprovals({
                organizationAndTeamData,
                repository: { id: 'repo-1', name: 'kodus' },
                prNumber: 42,
                reason: 'Sensitive path changed.',
            });
            const outcome = expect(dismissal).rejects.toThrow(
                'GitHub approval dismissal review=10 bounded timeout after 15000ms',
            );
            await jest.advanceTimersByTimeAsync(15_000);
            await outcome;
            expect(dismissReview).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('updates the repository config before removing deselected webhooks and ensuring selected ones', async () => {
        jest.spyOn(
            service,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue(previousRepositories);

        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.TOKEN,
        });

        const deleteWebhook = jest
            .spyOn(service, 'deleteWebhook')
            .mockResolvedValue(undefined);

        const createPullRequestWebhook = jest
            .spyOn(service, 'createPullRequestWebhook')
            .mockResolvedValue(undefined);

        await service.createOrUpdateIntegrationConfig({
            organizationAndTeamData,
            configKey: IntegrationConfigKey.REPOSITORIES,
            configValue: nextRepositories,
        });

        expect(deleteWebhook).toHaveBeenCalledWith({
            organizationAndTeamData,
            repositories: [{ id: '1', name: 'repo-one' }],
        });
        expect(
            integrationConfigService.createOrUpdateConfig,
        ).toHaveBeenCalledWith(
            IntegrationConfigKey.REPOSITORIES,
            nextRepositories,
            integration.uuid,
            organizationAndTeamData,
            undefined,
        );
        expect(
            integrationConfigService.createOrUpdateConfig.mock
                .invocationCallOrder[0],
        ).toBeLessThan(deleteWebhook.mock.invocationCallOrder[0]);
        expect(createPullRequestWebhook).toHaveBeenCalledWith({
            organizationAndTeamData,
            integrationId: integration.uuid,
        });
    });

    it('does not touch webhooks for non-repository config updates', async () => {
        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.TOKEN,
        });

        const deleteWebhook = jest
            .spyOn(service, 'deleteWebhook')
            .mockResolvedValue(undefined);

        const createPullRequestWebhook = jest
            .spyOn(service, 'createPullRequestWebhook')
            .mockResolvedValue(undefined);

        await service.createOrUpdateIntegrationConfig({
            organizationAndTeamData,
            configKey: IntegrationConfigKey.INSTALLATION_GITHUB,
            configValue: { installId: '123' },
        });

        expect(deleteWebhook).not.toHaveBeenCalled();
        expect(createPullRequestWebhook).not.toHaveBeenCalled();
    });

    it('uploads delete operations with valid tree mode/type', async () => {
        const octokitMock = {
            rest: {
                git: {
                    getRef: jest.fn().mockResolvedValue({
                        data: { object: { sha: 'base-sha' } },
                    }),
                    createBlob: jest.fn(),
                    createTree: jest.fn().mockResolvedValue({
                        data: { sha: 'tree-sha' },
                    }),
                    createCommit: jest.fn().mockResolvedValue({
                        data: { sha: 'commit-sha' },
                    }),
                    updateRef: jest.fn().mockResolvedValue({}),
                    createRef: jest.fn().mockResolvedValue({}),
                },
            },
        };

        jest.spyOn(service as any, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.TOKEN,
        });
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
            octokitMock as any,
        );
        jest.spyOn(service as any, 'getCorrectOwner').mockResolvedValue(
            'kodustech',
        );

        const result = await service.uploadFiles({
            organizationAndTeamData,
            repository: {
                id: 'repo-1',
                name: 'kodus',
            },
            branchName: 'main',
            baseBranch: 'main',
            files: [
                {
                    path: '.kody-rules/review/no-debug.yml',
                    operation: 'delete',
                },
            ],
            message: 'remove rule',
        });

        expect(result).toBe(true);
        expect(octokitMock.rest.git.createBlob).not.toHaveBeenCalled();
        expect(octokitMock.rest.git.createTree).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'kodustech',
                repo: 'kodus',
                tree: [
                    {
                        path: '.kody-rules/review/no-debug.yml',
                        mode: '100644',
                        type: 'blob',
                        sha: null,
                    },
                ],
            }),
        );
    });
});
