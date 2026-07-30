jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => ({
        id: 'TR-vbl-test',
        metadata: {},
    })),
}));

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { ChatWithKodyFromGitUseCase } from './chatWithKodyFromGit.use-case';

describe('ChatWithKodyFromGitUseCase', () => {
    let useCase: ChatWithKodyFromGitUseCase;
    let codeManagementService: {
        findTeamAndOrganizationIdByConfigKey: jest.Mock;
        addReactionToComment: jest.Mock;
        getPullRequestReviewComment: jest.Mock;
        createResponseToComment: jest.Mock;
    };
    let conversationAgentUseCase: {
        execute: jest.Mock;
    };
    let businessRulesValidationAgentUseCase: {
        execute: jest.Mock;
    };
    let permissionValidationService: {
        validateExecutionPermissions: jest.Mock;
    };

    beforeEach(() => {
        codeManagementService = {
            findTeamAndOrganizationIdByConfigKey: jest.fn().mockResolvedValue({
                integration: {
                    organization: {
                        uuid: 'org-1',
                    },
                },
                team: {
                    uuid: 'team-1',
                },
            }),
            addReactionToComment: jest.fn().mockResolvedValue(undefined),
            getPullRequestReviewComment: jest.fn().mockResolvedValue([]),
            createResponseToComment: jest.fn().mockResolvedValue({ id: 999 }),
        };
        conversationAgentUseCase = {
            execute: jest.fn().mockResolvedValue('an answer'),
        };
        businessRulesValidationAgentUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        permissionValidationService = {
            validateExecutionPermissions: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
        };

        const leaseManager = {
            acquire: jest.fn().mockResolvedValue({
                sandbox: { type: 'null', remoteCommands: undefined },
                leaseId: 'lease-test',
                wasCreated: true,
                sandboxId: 'sb-test',
            }),
            release: jest.fn().mockResolvedValue(undefined),
        };

        useCase = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            conversationAgentUseCase as any,
            businessRulesValidationAgentUseCase as any,
            permissionValidationService as any,
            leaseManager as any,
        );
    });

    it('passes GitHub PR refs to business logic validation comments', async () => {
        await useCase.execute({
            event: 'issue_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                },
                issue: {
                    id: 456,
                    body: 'PR description body',
                    pull_request: {
                        url: 'https://api.github.com/repos/kodus/kodus-extension/pulls/132',
                    },
                },
                pull_request: {
                    head: {
                        ref: 'feature/improve-refs',
                    },
                    base: {
                        ref: 'main',
                    },
                },
                comment: {
                    id: 123,
                    body: '@kody -v business-logic validate this change',
                },
                sender: {
                    id: 'user-1',
                    login: 'alice',
                },
            },
        } as any);

        expect(
            businessRulesValidationAgentUseCase.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                prepareContext: expect.objectContaining({
                    userQuestion:
                        '@kody -v business-logic validate this change',
                    pullRequestDescription: 'PR description body',
                    platformType: PlatformType.GITHUB,
                    repository: expect.objectContaining({
                        id: 'repo-1',
                        name: 'kodus-extension',
                        owner: 'kodus',
                    }),
                    pullRequest: {
                        pullRequestNumber: 132,
                        headRef: 'feature/improve-refs',
                        baseRef: 'main',
                    },
                }),
            }),
        );
    });

    it('passes the original Jira URL command body to business logic validation', async () => {
        const jiraUrl =
            'https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441';

        await useCase.execute({
            event: 'issue_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                },
                issue: {
                    id: 456,
                    body: 'PR description body',
                    pull_request: {
                        url: 'https://api.github.com/repos/kodus/kodus-extension/pulls/132',
                    },
                },
                pull_request: {
                    head: {
                        ref: 'feature/improve-refs',
                    },
                    base: {
                        ref: 'main',
                    },
                },
                comment: {
                    id: 123,
                    body: `@kody -v business-logic ${jiraUrl}`,
                },
                sender: {
                    id: 'user-1',
                    login: 'alice',
                },
            },
        } as any);

        expect(
            businessRulesValidationAgentUseCase.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    userQuestion: `@kody -v business-logic ${jiraUrl}`,
                    pullRequestDescription: 'PR description body',
                    repository: expect.objectContaining({
                        name: 'kodus-extension',
                        owner: 'kodus',
                    }),
                    pullRequest: expect.objectContaining({
                        pullRequestNumber: 132,
                    }),
                }),
            }),
        );
    });

    describe('conversation plan gate', () => {
        const conversationPayload = () =>
            ({
                event: 'issue_comment',
                platformType: PlatformType.GITHUB,
                payload: {
                    action: 'created',
                    repository: {
                        id: 'repo-1',
                        name: 'kodus-extension',
                    },
                    issue: {
                        id: 456,
                        body: 'PR description body',
                        pull_request: {
                            url: 'https://api.github.com/repos/kodus/kodus-extension/pulls/132',
                        },
                    },
                    pull_request: {
                        head: { ref: 'feature/improve-refs' },
                        base: { ref: 'main' },
                    },
                    comment: {
                        id: 123,
                        body: '@kody can we use optional chaining here?',
                    },
                    sender: {
                        id: 'user-1',
                        login: 'alice',
                    },
                },
            }) as any;

        // buildPrKey (used once the gate allows the run) requires a real UUID
        // organizationId, so the gate tests use valid UUIDs rather than the
        // 'org-1' placeholder the business-logic tests get away with.
        const ORG_UUID = '11111111-1111-4111-8111-111111111111';
        const TEAM_UUID = '22222222-2222-4222-8222-222222222222';

        beforeEach(() => {
            codeManagementService.findTeamAndOrganizationIdByConfigKey.mockResolvedValue(
                {
                    integration: { organization: { uuid: ORG_UUID } },
                    team: { uuid: TEAM_UUID },
                },
            );
            codeManagementService.getPullRequestReviewComment.mockResolvedValue(
                [
                    {
                        id: 123,
                        body: '@kody can we use optional chaining here?',
                        user: { login: 'alice' },
                    },
                ],
            );
            codeManagementService.getCloneParams = jest
                .fn()
                .mockResolvedValue(undefined);
        });

        it('runs the agent when the org has BYOK (any plan)', async () => {
            permissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: true,
                    byokConfig: { main: { provider: 'anthropic' } },
                },
            );

            await useCase.execute(conversationPayload());

            expect(
                permissionValidationService.validateExecutionPermissions,
            ).toHaveBeenCalledWith(
                { organizationId: ORG_UUID, teamId: TEAM_UUID },
                undefined,
                'ChatWithKodyFromGitUseCase',
            );
            expect(conversationAgentUseCase.execute).toHaveBeenCalled();
        });

        it('runs the agent on the default model for a trial org without BYOK', async () => {
            permissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: true,
                    byokConfig: null,
                    subscriptionStatus: 'trial',
                },
            );

            await useCase.execute(conversationPayload());

            expect(conversationAgentUseCase.execute).toHaveBeenCalled();
        });

        it('replies with BYOK guidance and skips the agent for a cloud org past the trial without BYOK', async () => {
            permissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: 'byok_required',
                },
            );

            await useCase.execute(conversationPayload());

            expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
            expect(
                codeManagementService.createResponseToComment,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.stringContaining('trial has ended'),
                    prNumber: 132,
                }),
            );
        });

        it('runs the agent for a managed/BYOK plan that returns NOT_ERROR (no per-seat block)', async () => {
            // A paid managed (or BYOK) org validated without a userGitId comes
            // back allowed:false + errorType NOT_ERROR — the "we skipped the
            // per-user check" signal, which the code-review pipeline treats as
            // a pass. The gate must NOT block it (it's not trial-ended).
            permissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: 'NOT_ERROR',
                },
            );

            await useCase.execute(conversationPayload());

            expect(conversationAgentUseCase.execute).toHaveBeenCalled();
            expect(
                codeManagementService.createResponseToComment,
            ).not.toHaveBeenCalledWith(
                expect.objectContaining({
                    body: expect.stringContaining('trial has ended'),
                }),
            );
        });
    });
});
