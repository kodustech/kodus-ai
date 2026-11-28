jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => ({
        id: 'TR-vbl-test',
        metadata: {},
    })),
}));

// Pass-through by default; a spec makes the open's observation fail.
jest.mock('@libs/core/log/langfuse', () => ({
    ...jest.requireActual('@libs/core/log/langfuse'),
    withLangfuseObservation: jest.fn(
        (_name: string, fn: (traceId?: string) => Promise<unknown>) =>
            fn(undefined),
    ),
}));

import { withLangfuseObservation } from '@libs/core/log/langfuse';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { ChatWithKodyFromGitUseCase } from './chatWithKodyFromGit.use-case';

const skippedWith = (reason: string, message: string) => ({
    outcome: { kind: 'skipped', reason, message },
    references: [],
    attempts: [],
});

describe('ChatWithKodyFromGitUseCase', () => {
    let useCase: ChatWithKodyFromGitUseCase;
    let codeManagementService: {
        findTeamAndOrganizationIdByConfigKey: jest.Mock;
        addReactionToComment: jest.Mock;
        getPullRequestReviewComment: jest.Mock;
        createResponseToComment: jest.Mock;
        createIssueComment: jest.Mock;
        updateIssueComment: jest.Mock;
        updateResponseToComment: jest.Mock;
        removeReactionsFromComment: jest.Mock;
        getCloneParams: jest.Mock;
    };
    let conversationAgentUseCase: {
        execute: jest.Mock;
    };
    let businessValidationService: {
        validate: jest.Mock;
    };
    let permissionValidationService: {
        validateExecutionPermissions: jest.Mock;
    };
    let leaseManager: {
        acquire: jest.Mock;
        release: jest.Mock;
    };
    let pullRequestsService: { findByNumberAndRepositoryId: jest.Mock };

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
            createIssueComment: jest.fn().mockResolvedValue({ id: 998 }),
            updateIssueComment: jest.fn().mockResolvedValue(undefined),
            updateResponseToComment: jest.fn().mockResolvedValue(undefined),
            removeReactionsFromComment: jest.fn().mockResolvedValue(undefined),
            getCloneParams: jest.fn().mockResolvedValue(undefined),
        };
        conversationAgentUseCase = {
            execute: jest.fn().mockResolvedValue('an answer'),
        };
        businessValidationService = {
            validate: jest
                .fn()
                .mockResolvedValue(
                    skippedWith('no_reference', 'No task found'),
                ),
        };
        permissionValidationService = {
            validateExecutionPermissions: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
        };

        leaseManager = {
            acquire: jest.fn().mockResolvedValue({
                sandbox: { type: 'null', remoteCommands: undefined },
                leaseId: 'lease-test',
                wasCreated: true,
                sandboxId: 'sb-test',
            }),
            release: jest.fn().mockResolvedValue(undefined),
        };

        pullRequestsService = {
            findByNumberAndRepositoryId: jest.fn().mockResolvedValue(null),
        };

        useCase = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            conversationAgentUseCase as any,
            businessValidationService as any,
            permissionValidationService as any,
            leaseManager as any,
            pullRequestsService as any,
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

        expect(businessValidationService.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                door: 'command',
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                taskInput: 'validate this change',
                platformType: PlatformType.GITHUB,
                repository: expect.objectContaining({
                    id: 'repo-1',
                    name: 'kodus-extension',
                }),
                pullRequest: expect.objectContaining({
                    number: 132,
                    body: 'PR description body',
                    headRef: 'feature/improve-refs',
                    baseRef: 'main',
                }),
            }),
        );
    });

    it('hands a quote reply to the Business Logic replies, the mention after the quote', async () => {
        const handle = jest.fn().mockResolvedValue({ handled: true });
        (useCase as any).businessLogicReplies = { handle };
        const body =
            '> Only teachers can download the export\n\n@kody this is done in the guard';

        await useCase.execute({
            event: 'issue_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                repository: { id: 'repo-1', name: 'kodus-extension' },
                issue: {
                    id: 456,
                    body: 'PR description body',
                    pull_request: {
                        url: 'https://api.github.com/repos/kodus/kodus-extension/pulls/132',
                    },
                },
                comment: { id: 123, body },
                sender: { id: 'user-1', login: 'alice' },
            },
        } as any);

        expect(handle).toHaveBeenCalledWith(
            expect.objectContaining({ message: body }),
        );
        expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
    });

    it('reads the branch from the PR when the GitHub comment webhook leaves it out', async () => {
        (codeManagementService as any).getPullRequest = jest
            .fn()
            .mockResolvedValue({
                head: { ref: 'feature/CU-86a1b2c3d-archive' },
            });

        await useCase.execute({
            event: 'issue_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                repository: { id: 'repo-1', name: 'kodus-extension' },
                issue: {
                    id: 456,
                    body: 'PR description body',
                    pull_request: {
                        url: 'https://api.github.com/repos/kodus/kodus-extension/pulls/132',
                    },
                },
                comment: { id: 123, body: '@kody -v business-logic' },
                sender: { id: 'user-1', login: 'alice' },
            },
        } as any);

        expect(businessValidationService.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: expect.objectContaining({
                    headRef: 'feature/CU-86a1b2c3d-archive',
                }),
            }),
        );
    });

    it('resolves a Forgejo comment on the instance that sent it', async () => {
        const webhookContextService = {
            getContext: jest.fn().mockResolvedValue(null),
        };
        const forgejo = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            conversationAgentUseCase as any,
            businessValidationService as any,
            permissionValidationService as any,
            leaseManager as any,
            pullRequestsService as any,
            undefined,
            undefined,
            undefined,
            webhookContextService as any,
        );

        await forgejo.execute({
            event: 'issue_comment',
            platformType: PlatformType.FORGEJO,
            payload: {
                action: 'created',
                repository: {
                    id: 26,
                    name: 'api',
                    full_name: 'beta/api',
                    html_url: 'https://git.beta.example/beta/api',
                },
                issue: { number: 21, body: 'PR description body' },
                pull_request: { number: 21 },
                comment: { id: 123, body: '@kody what does this do?' },
                sender: { id: 7, login: 'bob' },
            },
        } as any);

        expect(
            codeManagementService.findTeamAndOrganizationIdByConfigKey,
        ).toHaveBeenCalledWith(
            {
                repository: {
                    id: '26',
                    name: 'beta/api',
                    fullName: 'beta/api',
                    owner: 'beta',
                },
                host: 'git.beta.example',
                repositoryFullName: 'beta/api',
            },
            PlatformType.FORGEJO,
        );
        expect(webhookContextService.getContext).toHaveBeenCalledWith(
            PlatformType.FORGEJO,
            '26',
            { host: 'git.beta.example', repositoryFullName: 'beta/api' },
        );
    });

    it('resolves a GitLab comment on the server that sent it', async () => {
        // GitLab numbers projects per instance: project 9 of gitlab-b.example
        // must not be answered as another server's project 9.
        const webhookContextService = {
            getContext: jest.fn().mockResolvedValue(null),
        };
        const gitlab = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            conversationAgentUseCase as any,
            businessValidationService as any,
            permissionValidationService as any,
            leaseManager as any,
            pullRequestsService as any,
            undefined,
            undefined,
            undefined,
            webhookContextService as any,
        );

        await gitlab.execute({
            event: 'Note Hook',
            platformType: PlatformType.GITLAB,
            payload: {
                object_kind: 'note',
                user: { id: 7, username: 'bob' },
                project: {
                    id: 9,
                    name: 'billing-api',
                    path_with_namespace: 'globex/billing-api',
                    web_url: 'https://gitlab-b.example/globex/billing-api',
                    git_http_url:
                        'https://gitlab-b.example/globex/billing-api.git',
                },
                object_attributes: {
                    id: 123,
                    note: '@kody what does this do?',
                    noteable_type: 'MergeRequest',
                },
                merge_request: { iid: 21, description: 'PR description' },
            },
        } as any);

        expect(
            codeManagementService.findTeamAndOrganizationIdByConfigKey,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                host: 'gitlab-b.example',
                repositoryFullName: 'globex/billing-api',
            }),
            PlatformType.GITLAB,
        );
        expect(webhookContextService.getContext).toHaveBeenCalledWith(
            PlatformType.GITLAB,
            '9',
            {
                host: 'gitlab-b.example',
                repositoryFullName: 'globex/billing-api',
            },
        );
    });

    it('answers as the team whose review runs on the repository when it is connected in two organizations', async () => {
        const webhookContextService = {
            getContext: jest.fn().mockResolvedValue({
                organizationAndTeamData: {
                    organizationId: 'org-2',
                    teamId: 'team-2',
                },
                teamAutomationId: 'automation-2',
            }),
        };
        const twoOrgs = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            conversationAgentUseCase as any,
            businessValidationService as any,
            permissionValidationService as any,
            leaseManager as any,
            pullRequestsService as any,
            undefined,
            undefined,
            undefined,
            webhookContextService as any,
        );

        await twoOrgs.execute({
            event: 'issue_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                    full_name: 'kodus/kodus-extension',
                    html_url: 'https://github.com/kodus/kodus-extension',
                },
                issue: {
                    id: 456,
                    body: 'PR description body',
                    pull_request: {
                        url: 'https://api.github.com/repos/kodus/kodus-extension/pulls/132',
                    },
                },
                comment: { id: 123, body: '@kody -v business-logic' },
                sender: { id: 'user-1', login: 'alice' },
            },
        } as any);

        // Resolved on the server that sent the comment (per server on GitHub
        // Enterprise Server).
        expect(webhookContextService.getContext).toHaveBeenCalledWith(
            PlatformType.GITHUB,
            'repo-1',
            {
                host: 'github.com',
                repositoryFullName: 'kodus/kodus-extension',
            },
        );
        expect(businessValidationService.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-2',
                    teamId: 'team-2',
                },
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

        expect(businessValidationService.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                taskInput: jiraUrl,
                pullRequest: expect.objectContaining({
                    number: 132,
                    body: 'PR description body',
                }),
            }),
        );
    });

    // An explicit ask always gets an answer: when nothing was validated the
    // reply says why, in place of the old internal __NO_TASK_MCP__ marker.
    it('replies with the reason when nothing was validated', async () => {
        businessValidationService.validate.mockResolvedValueOnce(
            skippedWith('no_tracker', 'No task-management MCP is connected.'),
        );

        const response = await (useCase as any).handleBusinessLogicValidation({
            prepareContext: { userQuestion: '@kody -v business-logic' },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            thread: undefined,
        });

        expect(response).toMatch(/no task-management mcp/i);
    });

    it('lets only people with write access waive a requirement on GitHub', async () => {
        // GitHub sends COLLABORATOR for a read-only collaborator and MEMBER
        // for any organization member, so the association can only rule out.
        const permission: Record<string, boolean | undefined> = {
            writer: true,
            reader: false,
        };
        const userCanWrite = jest.fn(
            async ({ login }: { login: string }) => permission[login],
        );
        (useCase as any).codeManagementService = { userCanWrite };
        const access = (association: string | undefined, login = 'reader') =>
            (useCase as any).senderAccess(
                {
                    platformType: PlatformType.GITHUB,
                    payload: {
                        sender: { login },
                        issue: { user: { login: 'rafa' } },
                        comment: { author_association: association },
                    },
                },
                { organizationId: 'org-1' },
                { id: 'repo-1', name: 'notes', owner: 'acme' },
            );

        await expect(access('COLLABORATOR', 'reader')).resolves.toEqual({
            canWrite: false,
            isAuthor: false,
        });
        await expect(access('MEMBER', 'reader')).resolves.toMatchObject({
            canWrite: false,
        });
        await expect(access('MEMBER', 'writer')).resolves.toEqual({
            canWrite: true,
            isAuthor: false,
        });
        expect(userCanWrite).toHaveBeenCalledWith(
            {
                organizationAndTeamData: { organizationId: 'org-1' },
                repository: { id: 'repo-1', name: 'notes', owner: 'acme' },
                login: 'writer',
            },
            PlatformType.GITHUB,
        );

        userCanWrite.mockClear();
        await expect(access('CONTRIBUTOR', 'writer')).resolves.toMatchObject({
            canWrite: false,
        });
        await expect(access('NONE', 'writer')).resolves.toMatchObject({
            canWrite: false,
        });
        expect(userCanWrite).not.toHaveBeenCalled();

        // Without a login there is no one to ask: never the member list.
        await expect(access('MEMBER', '')).resolves.toMatchObject({
            canWrite: false,
        });

        // A lookup that fails or can't say throws: the reply says access
        // couldn't be checked and accepts nothing, instead of "no write
        // access" to someone who has it.
        jest.spyOn((useCase as any).logger, 'error').mockImplementation(
            () => undefined,
        );
        userCanWrite.mockRejectedValueOnce(new Error('502'));
        await expect(access('OWNER', 'writer')).rejects.toThrow('502');
        await expect(access('OWNER', 'unknown')).rejects.toThrow(
            /could not say/,
        );
    });

    it("asks the other platforms for the organization's members, and knows the PR's author", async () => {
        const getListMembers = jest.fn(async () => [
            { id: 'u7', name: 'Nina' },
        ]);
        (useCase as any).codeManagementService = { getListMembers };
        const access = (userId: number, authorId = 9) =>
            (useCase as any).senderAccess(
                {
                    platformType: PlatformType.BITBUCKET,
                    payload: {
                        actor: { uuid: `{u${userId}}`, display_name: 'Nina' },
                        pullrequest: { author: { uuid: `{u${authorId}}` } },
                    },
                },
                { organizationId: 'org-1' },
                { id: 'repo-1' },
            );
        await expect(access(7)).resolves.toEqual({
            canWrite: true,
            isAuthor: false,
        });
        await expect(access(8)).resolves.toMatchObject({ canWrite: false });
        await expect(access(7, 7)).resolves.toMatchObject({ isAuthor: true });
        jest.spyOn((useCase as any).logger, 'error').mockImplementation(
            () => undefined,
        );
        getListMembers.mockRejectedValueOnce(new Error('403'));
        await expect(access(7)).rejects.toThrow('403');
        // An actor with only account_id names no key members are listed by:
        // it cannot be checked, rather than read as a non-member.
        await expect(
            (useCase as any).senderAccess(
                {
                    platformType: PlatformType.BITBUCKET,
                    payload: {
                        actor: { account_id: 'u7', display_name: 'Nina' },
                        pullrequest: { author: { uuid: '{u9}' } },
                    },
                },
                { organizationId: 'org-1' },
                { id: 'repo-1' },
            ),
        ).rejects.toThrow(/named no commenter/);
    });

    it("asks GitLab and Forgejo for the commenter's permission, never the member list, and knows Forgejo's author", async () => {
        const getListMembers = jest.fn();
        const userCanWrite = jest.fn(async () => false);
        (useCase as any).codeManagementService = {
            getListMembers,
            userCanWrite,
        };
        await expect(
            (useCase as any).senderAccess(
                {
                    platformType: PlatformType.GITLAB,
                    payload: {
                        user: { id: 7, name: 'guest' },
                        merge_request: { author_id: 9 },
                    },
                },
                { organizationId: 'org-1' },
                { id: 'repo-1' },
            ),
        ).resolves.toEqual({ canWrite: false, isAuthor: false });
        expect(userCanWrite).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 7,
                repository: { id: 'repo-1' },
            }),
            PlatformType.GITLAB,
        );
        expect(getListMembers).not.toHaveBeenCalled();

        // A failed or empty level lookup throws, so nothing is accepted and
        // the reply says access couldn't be checked.
        const gitlab = {
            platformType: PlatformType.GITLAB,
            payload: {
                user: { id: 7, name: 'guest' },
                merge_request: { author_id: 9 },
            },
        };
        const logged = jest
            .spyOn((useCase as any).logger, 'error')
            .mockImplementation(() => undefined);
        userCanWrite.mockRejectedValueOnce(new Error('502'));
        await expect(
            (useCase as any).senderAccess(
                gitlab,
                { organizationId: 'org-1' },
                { id: 'repo-1' },
            ),
        ).rejects.toThrow('502');
        expect(logged).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    repositoryId: 'repo-1',
                    senderId: 7,
                }),
            }),
        );
        userCanWrite.mockResolvedValueOnce(undefined as any);
        await expect(
            (useCase as any).senderAccess(
                gitlab,
                { organizationId: 'org-1' },
                { id: 'repo-1' },
            ),
        ).rejects.toThrow(/could not say/);

        await expect(
            (useCase as any).senderAccess(
                {
                    platformType: PlatformType.FORGEJO,
                    payload: {
                        sender: { id: 5, login: 'ana' },
                        comment: { user: { id: 5, login: 'ana' } },
                        pull_request: { user: { id: 5, login: 'ana' } },
                    },
                },
                { organizationId: 'org-1' },
                { id: 'repo-1', name: 'acme/api' },
            ),
        ).resolves.toEqual({ isAuthor: true, canWrite: false });
        expect(userCanWrite).toHaveBeenLastCalledWith(
            expect.objectContaining({
                login: 'ana',
                repository: { id: 'repo-1', name: 'acme/api' },
            }),
            PlatformType.FORGEJO,
        );
        expect(getListMembers).not.toHaveBeenCalled();

        // An empty member list is a read that failed, not nobody.
        getListMembers.mockResolvedValueOnce([]);
        await expect(
            (useCase as any).senderAccess(
                {
                    platformType: PlatformType.BITBUCKET,
                    payload: {
                        actor: { uuid: '{u5}' },
                        pullrequest: { author: { uuid: '{u9}' } },
                    },
                },
                { organizationId: 'org-1' },
                { id: 'repo-1' },
            ),
        ).rejects.toThrow(/no members/);
    });

    // A bare `#12` is read from the PR's repository, which needs its owner.
    it('passes the repository owner to the validation', async () => {
        businessValidationService.validate.mockResolvedValueOnce(
            skippedWith('no_tracker', 'No task-management MCP is connected.'),
        );

        await (useCase as any).handleBusinessLogicValidation({
            prepareContext: {
                userQuestion: '@kody -v business-logic #12',
                repository: { id: 'repo-1', name: 'web', owner: 'acme' },
                pullRequestNumber: 7,
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            thread: undefined,
        });

        expect(businessValidationService.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({ owner: 'acme' }),
            }),
        );
    });

    it('publishes a verdict through the publisher and points to the edited comment', async () => {
        const outcome = {
            kind: 'validated',
            checks: [
                {
                    task: { tracker: 'Linear', id: 'PLAT-41' },
                    verdict: { needsMoreInfo: false, summary: 'x' },
                    passed: false,
                    readAt: '2026-10-05T00:00:00.000Z',
                },
            ],
            thinTasks: [],
            passed: false,
            unseenFiles: [],
        };
        businessValidationService.validate.mockResolvedValueOnce({
            outcome,
            references: [],
            attempts: [],
            trackers: ['Linear'],
        });
        const publisher = {
            configFor: jest
                .fn()
                .mockResolvedValue({ settings: {}, enabled: true }),
            withRepository: jest.fn((r: unknown) => r),
            headShaOf: jest.fn().mockResolvedValue('abc1234'),
            publish: jest
                .fn()
                .mockResolvedValue({ outcome, comment: 'updated' }),
        };
        (useCase as any).businessLogicPublisher = publisher;

        const response = await (useCase as any).handleBusinessLogicValidation({
            prepareContext: {
                userQuestion: '@kody -v business-logic',
                repository: { id: 'repo-1', name: 'kodus-extension' },
                pullRequest: { pullRequestNumber: 132 },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            thread: undefined,
        });

        expect(publisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                trigger: 'command',
                headSha: 'abc1234',
                request: expect.objectContaining({ door: 'command' }),
            }),
        );
        expect(response).toContain('comment on this pull request is updated');

        // A re-check that lands on the same verdict says so (#2423).
        businessValidationService.validate.mockResolvedValueOnce({
            outcome,
            references: [],
            attempts: [],
            trackers: ['Linear'],
        });
        publisher.publish.mockResolvedValueOnce({
            outcome,
            comment: 'updated',
            changed: false,
        });
        const again = await (useCase as any).handleBusinessLogicValidation({
            prepareContext: {
                userQuestion: '@kody -v business-logic',
                repository: { id: 'repo-1', name: 'kodus-extension' },
                pullRequest: { pullRequestNumber: 132 },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            thread: undefined,
        });
        expect(again).toContain('same result as before');
        expect(again).not.toContain('updated');
    });

    it('does not say the comment was updated when the command posts the first one', async () => {
        const outcome = {
            kind: 'validated',
            checks: [
                {
                    task: { tracker: 'Linear', id: 'PLAT-41' },
                    verdict: { needsMoreInfo: false, summary: 'x' },
                    passed: true,
                    readAt: '2026-10-05T00:00:00.000Z',
                },
            ],
            thinTasks: [],
            passed: true,
            unseenFiles: [],
        };
        businessValidationService.validate.mockResolvedValueOnce({
            outcome,
            references: [],
            attempts: [],
            trackers: ['Linear'],
        });
        (useCase as any).businessLogicPublisher = {
            configFor: jest
                .fn()
                .mockResolvedValue({ settings: {}, enabled: true }),
            withRepository: jest.fn((r: unknown) => r),
            headShaOf: jest.fn().mockResolvedValue('abc1234'),
            publish: jest
                .fn()
                .mockResolvedValue({ outcome, comment: 'created' }),
        };

        const response = await (useCase as any).handleBusinessLogicValidation({
            prepareContext: {
                userQuestion: '@kody -v business-logic',
                repository: { id: 'repo-1', name: 'kodus-extension' },
                pullRequest: { pullRequestNumber: 132 },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            thread: undefined,
        });

        expect(response).not.toContain('updated');
        expect(response).toContain('Kody · Business Logic comment');
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

        it('says the subscription check is unavailable, not that the trial ended, when the license read fails', async () => {
            // Billing answered 5xx / timed out (#2452): the org may be paying,
            // so the reply must not send it to the plan page.
            permissionValidationService.validateExecutionPermissions.mockResolvedValue(
                {
                    allowed: false,
                    errorType: 'LICENSE_UNAVAILABLE',
                },
            );

            await useCase.execute(conversationPayload());

            expect(conversationAgentUseCase.execute).not.toHaveBeenCalled();
            expect(
                codeManagementService.createResponseToComment,
            ).toHaveBeenCalledTimes(1);
            const { body } =
                codeManagementService.createResponseToComment.mock.calls[0][0];
            expect(body).toContain(
                'the license service is temporarily unreachable',
            );
            expect(body).not.toContain('trial has ended');
            expect(body).not.toContain('BYOK');
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

        describe('sandbox opened on the first repository read (#2629)', () => {
            const readsWith =
                (read: (open: () => Promise<any>) => Promise<unknown>) =>
                async ({
                    openSandbox,
                }: {
                    openSandbox: () => Promise<any>;
                }) => {
                    await read(openSandbox);
                    return 'an answer';
                };

            it('opens nothing for a reply that reads no code', async () => {
                await useCase.execute(conversationPayload());

                expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
                    expect.objectContaining({
                        openSandbox: expect.any(Function),
                    }),
                );
                expect(
                    codeManagementService.getCloneParams,
                ).not.toHaveBeenCalled();
                expect(leaseManager.acquire).not.toHaveBeenCalled();
                expect(leaseManager.release).not.toHaveBeenCalled();
            });

            it('opens once for parallel first reads and releases after the run', async () => {
                const sandbox = { type: 'e2b', remoteCommands: {} };
                leaseManager.acquire.mockResolvedValue({
                    sandbox,
                    leaseId: 'lease-test',
                    wasCreated: false,
                    sandboxId: 'sb-test',
                });
                let opened: unknown[] = [];
                conversationAgentUseCase.execute.mockImplementation(
                    readsWith(async (open) => {
                        opened = await Promise.all([open(), open()]);
                        expect(leaseManager.release).not.toHaveBeenCalled();
                    }),
                );

                await useCase.execute(conversationPayload());

                expect(opened).toEqual([sandbox, sandbox]);
                expect(
                    codeManagementService.getCloneParams,
                ).toHaveBeenCalledTimes(1);
                expect(leaseManager.acquire).toHaveBeenCalledTimes(1);
                expect(leaseManager.acquire).toHaveBeenCalledWith(
                    expect.stringContaining(ORG_UUID),
                    'conversation',
                    5 * 60 * 1000,
                    undefined,
                );
                expect(leaseManager.release).toHaveBeenCalledTimes(1);
                expect(leaseManager.release).toHaveBeenCalledWith('lease-test');
            });

            it('continues with a null sandbox when the open fails', async () => {
                leaseManager.acquire.mockRejectedValue(
                    new Error('git clone failed with 403'),
                );
                let opened: any;
                conversationAgentUseCase.execute.mockImplementation(
                    readsWith(async (open) => {
                        opened = await open();
                    }),
                );

                await useCase.execute(conversationPayload());

                expect(opened).toEqual(
                    expect.objectContaining({ type: 'null' }),
                );
                expect(leaseManager.release).not.toHaveBeenCalled();
                expect(
                    codeManagementService.createResponseToComment,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        body: expect.stringContaining('an answer'),
                    }),
                );
            });

            it('keeps the reply and releases the lease when the open fails after acquiring', async () => {
                (withLangfuseObservation as jest.Mock).mockImplementationOnce(
                    async (_name: string, fn: () => Promise<unknown>) => {
                        await fn();
                        throw new Error('span export failed');
                    },
                );
                // The repository tools catch a rejected open (they answer
                // REPOSITORY_UNAVAILABLE), as this read does.
                conversationAgentUseCase.execute.mockImplementation(
                    readsWith((open) => open().catch(() => undefined)),
                );

                await useCase.execute(conversationPayload());
                expect(leaseManager.release).toHaveBeenCalledWith('lease-test');
                expect(
                    codeManagementService.createResponseToComment,
                ).toHaveBeenCalledWith(
                    expect.objectContaining({
                        body: expect.stringContaining('an answer'),
                    }),
                );
            });

            it('releases a lease whose open was still in flight when the run ended', async () => {
                let grant!: (lease: unknown) => void;
                leaseManager.acquire.mockReturnValue(
                    new Promise((resolve) => (grant = resolve)),
                );
                conversationAgentUseCase.execute.mockImplementation(
                    async ({ openSandbox }) => {
                        void openSandbox();
                        // The run ends (here, by failing) before the open does.
                        setTimeout(
                            () =>
                                grant({
                                    sandbox: { type: 'e2b' },
                                    leaseId: 'late-lease',
                                    wasCreated: true,
                                    sandboxId: 'sb',
                                }),
                            10,
                        );
                        throw new Error('model timed out');
                    },
                );

                await useCase.execute(conversationPayload());

                expect(leaseManager.release).toHaveBeenCalledWith('late-lease');
            });
        });
    });

    it('handles Bitbucket description as a structured content object', async () => {
        const ORG_UUID = '11111111-1111-4111-8111-111111111111';
        const TEAM_UUID = '22222222-2222-4222-8222-222222222222';
        codeManagementService.findTeamAndOrganizationIdByConfigKey.mockResolvedValue(
            {
                integration: { organization: { uuid: ORG_UUID } },
                team: { uuid: TEAM_UUID },
            },
        );
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            {
                id: 123,
                body: '@kody what changed?',
                author: { username: 'alice' },
            },
        ]);
        codeManagementService.createResponseToComment.mockResolvedValue({
            id: 999,
            parent: { id: 123 },
        });
        permissionValidationService.validateExecutionPermissions.mockResolvedValue(
            { allowed: true },
        );

        await useCase.execute({
            event: 'pullrequest:comment_created',
            platformType: PlatformType.BITBUCKET,
            payload: {
                pullrequest: {
                    id: 42,
                    title: 'Add feature',
                    description: {
                        raw: 'Bitbucket description raw text',
                        html: '<p>Bitbucket description raw text</p>',
                        markup: 'markdown',
                    },
                    source: {
                        branch: { name: 'feature' },
                        repository: { full_name: 'acme/repo' },
                    },
                    destination: {
                        branch: { name: 'main' },
                        repository: { full_name: 'acme/repo' },
                    },
                },
                comment: {
                    id: 123,
                    content: { raw: '@kody what changed?' },
                    user: { nickname: 'alice' },
                },
                actor: { id: 'user-1', nickname: 'alice' },
            },
        } as any);

        expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    pullRequestDescription: 'Bitbucket description raw text',
                }),
            }),
        );
    });

    it('uses GitLab path_with_namespace for sandbox clone params', async () => {
        const ORG_UUID = '11111111-1111-4111-8111-111111111111';
        const TEAM_UUID = '22222222-2222-4222-8222-222222222222';
        codeManagementService.findTeamAndOrganizationIdByConfigKey.mockResolvedValue(
            {
                integration: { organization: { uuid: ORG_UUID } },
                team: { uuid: TEAM_UUID },
            },
        );
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            {
                id: 123,
                body: '@kody what changed?',
                discussionId: 'discussion-1',
                author: { username: 'alice' },
            },
        ]);
        codeManagementService.getCloneParams.mockResolvedValue({
            url: 'https://gitlab.com/juniorsartori/kodex',
            auth: { token: 'token' },
        });
        permissionValidationService.validateExecutionPermissions.mockResolvedValue(
            { allowed: true },
        );
        // Clone params are resolved when the agent first reads the repository.
        conversationAgentUseCase.execute.mockImplementation(
            async ({ openSandbox }) => {
                await openSandbox();
                return 'an answer';
            },
        );

        await useCase.execute({
            event: 'Note Hook',
            platformType: PlatformType.GITLAB,
            payload: {
                object_attributes: {
                    id: 123,
                    note: '@kody what changed?',
                    discussion_id: 'discussion-1',
                    action: 'create',
                },
                project: {
                    id: 77,
                    name: 'kodex',
                    namespace: 'Junior Sartori',
                    path_with_namespace: 'juniorsartori/kodex',
                    default_branch: 'main',
                },
                merge_request: {
                    iid: 33,
                    source_branch: 'feat/goals',
                    target_branch: 'main',
                    description: 'Description',
                },
                user: { id: 1, username: 'alice' },
            },
        } as any);

        expect(codeManagementService.getCloneParams).toHaveBeenCalledWith(
            expect.objectContaining({
                repository: expect.objectContaining({
                    fullName: 'juniorsartori/kodex',
                }),
            }),
            PlatformType.GITLAB,
        );
    });

    it('answers an @kody mention that starts a brand-new Azure DevOps thread (not a reply)', async () => {
        // Regression test: getPullRequestReviewComment groups Azure comments
        // by thread and puts everything AFTER the first comment into
        // `.replies` — the thread's root comment lives on the thread object
        // itself. getReviewThreadByCommentId used to only search `.replies`,
        // so a brand-new `@kody <question>` (the root comment of a fresh
        // thread, not a reply to an existing one) was never found and Kody
        // silently never answered. Confirmed live against a real Azure
        // DevOps PR: a single-comment thread's lone comment never got a
        // reply.
        const ORG_UUID = '11111111-1111-4111-8111-111111111111';
        const TEAM_UUID = '22222222-2222-4222-8222-222222222222';
        codeManagementService.findTeamAndOrganizationIdByConfigKey.mockResolvedValue(
            {
                integration: { organization: { uuid: ORG_UUID } },
                team: { uuid: TEAM_UUID },
            },
        );
        codeManagementService.getPullRequestReviewComment.mockResolvedValue([
            {
                id: 1,
                threadId: 3239,
                replies: [],
                body: '@kody what does this pull request change?',
                createdAt: '2026-08-18T18:19:00.000Z',
                author: { id: 'author-1', name: 'alice' },
            },
        ]);
        codeManagementService.updateResponseToComment = jest
            .fn()
            .mockResolvedValue({});
        permissionValidationService.validateExecutionPermissions.mockResolvedValue(
            { allowed: true },
        );

        await useCase.execute({
            event: 'ms.vss-code.git-pullrequest-comment-event',
            platformType: PlatformType.AZURE_REPOS,
            payload: {
                resource: {
                    comment: {
                        id: 1,
                        content: '@kody what does this pull request change?',
                        parentCommentId: 0,
                        author: { displayName: 'alice', id: 'author-1' },
                        _links: {
                            threads: {
                                href: 'https://dev.azure.com/org/proj/_apis/git/repositories/repo/pullRequests/55/threads/3239',
                            },
                        },
                    },
                    pullRequest: {
                        pullRequestId: 55,
                        repository: { id: 'repo-1', name: 'kodus-e2e' },
                        sourceRefName: 'refs/heads/feature',
                        targetRefName: 'refs/heads/main',
                        description: 'PR description',
                    },
                    repository: { project: { name: 'kodus-e2e-project' } },
                },
                resourceContainers: { project: { id: 'project-1' } },
            },
        } as any);

        expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    userQuestion: '@kody what does this pull request change?',
                }),
            }),
        );
    });
});

describe('ChatWithKodyFromGitUseCase — rule behind the finding', () => {
    const KODY_COMMENT_ID = 555;
    // buildPrKey rejects a non-UUID organization id.
    const ORGANIZATION_ID = '11111111-1111-1111-1111-111111111111';

    function buildParams() {
        return {
            event: 'pull_request_review_comment',
            platformType: PlatformType.GITHUB,
            payload: {
                action: 'created',
                repository: { id: 'repo-1', name: 'billing-api' },
                issue: {
                    id: 1,
                    body: 'body',
                    pull_request: {
                        url: 'https://api.github.com/repos/acme/billing-api/pulls/812',
                    },
                },
                comment: {
                    id: 900,
                    in_reply_to_id: KODY_COMMENT_ID,
                    body: '@kody this is a false positive',
                    path: 'src/worker/invoice.ts',
                },
                pull_request: {
                    number: 812,
                    head: { ref: 'feat/invoice-retry' },
                    base: { ref: 'main' },
                },
                sender: { id: 'user-1', login: 'dev-one' },
            },
        } as any;
    }

    function build(pullRequest: unknown) {
        const conversationAgentUseCase = {
            execute: jest.fn().mockResolvedValue('an answer'),
        };
        const pullRequestsService = {
            findByNumberAndRepositoryId: jest
                .fn()
                .mockResolvedValue(pullRequest),
        };
        const useCase = new ChatWithKodyFromGitUseCase(
            {
                findTeamAndOrganizationIdByConfigKey: jest
                    .fn()
                    .mockResolvedValue({
                        integration: {
                            organization: { uuid: ORGANIZATION_ID },
                        },
                        team: { uuid: 'team-1' },
                    }),
                addReactionToComment: jest.fn().mockResolvedValue(undefined),
                getPullRequestReviewComment: jest.fn().mockResolvedValue([
                    {
                        id: KODY_COMMENT_ID,
                        body: 'Wrap the call in a try/catch. <!-- kody-codereview -->',
                        user: { login: 'kody-codereview' },
                        diff_hunk: '@@ -1 +1 @@',
                    },
                    {
                        id: 900,
                        in_reply_to_id: KODY_COMMENT_ID,
                        body: '@kody this is a false positive',
                        path: 'src/worker/invoice.ts',
                        user: { login: 'dev-one' },
                    },
                ]),
                createResponseToComment: jest
                    .fn()
                    .mockResolvedValue({ id: 999 }),
                removeReactionsFromComment: jest
                    .fn()
                    .mockResolvedValue(undefined),
                getCloneParams: jest.fn().mockResolvedValue(undefined),
            } as any,
            conversationAgentUseCase as any,
            { execute: jest.fn() } as any,
            {
                validateExecutionPermissions: jest
                    .fn()
                    .mockResolvedValue({ allowed: true }),
            } as any,
            {
                acquire: jest.fn().mockResolvedValue({
                    sandbox: { type: 'null' },
                    leaseId: 'lease',
                    wasCreated: true,
                    sandboxId: 'sb',
                }),
                release: jest.fn().mockResolvedValue(undefined),
            } as any,
            pullRequestsService as any,
        );

        return { useCase, conversationAgentUseCase, pullRequestsService };
    }

    it('attaches the rule ids of the suggestion the thread started from', async () => {
        const { useCase, conversationAgentUseCase } = build({
            files: [
                {
                    suggestions: [
                        {
                            id: 'sug-9',
                            label: 'kody_rules',
                            brokenKodyRulesIds: ['rule-abc'],
                            comment: { id: KODY_COMMENT_ID },
                        },
                        {
                            id: 'sug-other',
                            comment: { id: 111 },
                        },
                    ],
                },
            ],
        });

        await useCase.execute(buildParams());

        expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    codeManagementContext: expect.objectContaining({
                        originalComment: expect.objectContaining({
                            suggestionId: 'sug-9',
                            label: 'kody_rules',
                            brokenKodyRulesIds: ['rule-abc'],
                        }),
                    }),
                }),
            }),
        );
    });

    it('finds the rule ids of a PR-level finding too', async () => {
        const { useCase, conversationAgentUseCase } = build({
            files: [],
            prLevelSuggestions: [
                {
                    id: 'sug-pr-1',
                    label: 'kody_rules',
                    brokenKodyRulesIds: ['rule-pr'],
                    comment: { id: KODY_COMMENT_ID },
                },
            ],
        });

        await useCase.execute(buildParams());

        expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    codeManagementContext: expect.objectContaining({
                        originalComment: expect.objectContaining({
                            suggestionId: 'sug-pr-1',
                            brokenKodyRulesIds: ['rule-pr'],
                        }),
                    }),
                }),
            }),
        );
    });

    it('still answers when the suggestion cannot be resolved', async () => {
        const { useCase, conversationAgentUseCase } = build(null);

        await useCase.execute(buildParams());

        expect(conversationAgentUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                prepareContext: expect.objectContaining({
                    codeManagementContext: expect.objectContaining({
                        originalComment: expect.objectContaining({
                            suggestionId: undefined,
                        }),
                    }),
                }),
            }),
        );
    });

    describe('Forgejo lookups (#2779)', () => {
        const issueComment = {
            event: 'issue_comment',
            platformType: PlatformType.FORGEJO,
            payload: {
                repository: { default_branch: 'main' },
                issue: { number: 21, body: 'Issue body' },
                comment: { id: 123, body: '@kody explain' },
            },
        };
        const reviewComment = {
            event: 'pull_request_review_comment',
            platformType: PlatformType.FORGEJO,
            payload: {
                repository: { default_branch: 'main' },
                pull_request: {
                    number: 22,
                    body: 'PR body',
                    head: { ref: 'feature/x' },
                    base: { ref: 'develop' },
                },
                comment: { id: 456, body: '@kody explain' },
            },
        };
        const lookups = Object.assign(
            Object.create(ChatWithKodyFromGitUseCase.prototype),
            { logger: { log: jest.fn(), warn: jest.fn() } },
        );
        const call = (method: string, params: unknown) =>
            lookups[method](params);

        afterEach(() => {
            // No lookup falls to the "Unsupported platform type" default.
            expect(lookups.logger.warn).not.toHaveBeenCalled();
        });

        it('reads the PR number from an issue comment and a review comment', () => {
            expect(call('getPullRequestNumber', issueComment)).toBe(21);
            expect(call('getPullRequestNumber', reviewComment)).toBe(22);
        });

        it('reads the comment id', () => {
            expect(call('getCommentId', issueComment)).toBe(123);
            expect(call('getCommentId', reviewComment)).toBe(456);
        });

        it('reads the head ref', () => {
            expect(call('getHeadRef', reviewComment)).toBe('feature/x');
        });

        it('reads the base ref', () => {
            expect(call('getBaseRef', reviewComment)).toBe('develop');
        });

        it('reads the default branch', () => {
            expect(call('getDefaultBranch', issueComment)).toBe('main');
        });

        it('tells an inline reply from a general comment', () => {
            const inline = {
                ...issueComment,
                payload: {
                    ...issueComment.payload,
                    comment: {
                        id: 7,
                        html_url:
                            'https://codeberg.org/o/r/pulls/21/files#issuecomment-7',
                    },
                },
            };
            const general = {
                ...issueComment,
                payload: {
                    ...issueComment.payload,
                    comment: {
                        id: 8,
                        html_url:
                            'https://codeberg.org/o/r/pulls/21#issuecomment-8',
                    },
                },
            };
            expect(call('isGeneralComment', inline)).toBe(false);
            expect(call('isGeneralComment', reviewComment)).toBe(false);
            expect(call('isGeneralComment', general)).toBe(true);
        });

        it('reads the git user from the comment', () => {
            expect(
                call('getGitUser', {
                    ...issueComment,
                    payload: {
                        comment: { id: 1, user: { id: 7, login: 'bob' } },
                    },
                }),
            ).toEqual({ id: 7, username: 'bob' });
        });

        it('reads the PR description from the PR or the issue', () => {
            expect(call('getPullRequestDescription', reviewComment)).toBe(
                'PR body',
            );
            expect(call('getPullRequestDescription', issueComment)).toBe(
                'Issue body',
            );
        });
    });
});
