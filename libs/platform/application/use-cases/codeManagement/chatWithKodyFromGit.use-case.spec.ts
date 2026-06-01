jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
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
    };
    let conversationAgentUseCase: {
        execute: jest.Mock;
    };
    let businessRulesValidationAgentUseCase: {
        execute: jest.Mock;
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
        };
        conversationAgentUseCase = {
            execute: jest.fn(),
        };
        businessRulesValidationAgentUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
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
});
