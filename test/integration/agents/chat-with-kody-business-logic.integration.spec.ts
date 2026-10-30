jest.mock('@libs/common/utils/thread-id', () => ({
    createThreadId: jest.fn(() => ({
        id: 'TR-vbl-integration',
        metadata: {},
    })),
}));

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';

describe('ChatWithKodyFromGitUseCase business-logic integration', () => {
    let chatUseCase: ChatWithKodyFromGitUseCase;
    let businessValidationService: { validate: jest.Mock };
    let codeManagementService: {
        findTeamAndOrganizationIdByConfigKey: jest.Mock;
        addReactionToComment: jest.Mock;
        createIssueComment: jest.Mock;
        removeReactionsFromComment: jest.Mock;
    };

    beforeEach(() => {
        jest.restoreAllMocks();
        businessValidationService = {
            validate: jest.fn().mockResolvedValue({
                outcome: {
                    kind: 'skipped',
                    reason: 'task_not_found',
                    message: '## 🤔 Tarefa não encontrada',
                },
                references: [],
                attempts: [],
                trackers: ['Jira'],
            }),
        };
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
            createIssueComment: jest.fn().mockResolvedValue({ id: 999 }),
            removeReactionsFromComment: jest.fn().mockResolvedValue(undefined),
        };

        chatUseCase = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            { execute: jest.fn() } as any,
            businessValidationService as unknown as BusinessValidationService,
            {} as any,
            {} as any,
        );
    });

    it('answers the command through BusinessValidationService', async () => {
        const params = {
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
                    body: '@kody -v business-logic https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                },
                sender: {
                    id: 'user-1',
                    login: 'alice',
                },
            },
        };

        await (chatUseCase as any).handleBusinessLogicFlow(
            params,
            {
                id: 'repo-1',
                name: 'kodus-extension',
            },
            132,
            'PR description body',
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            'feature/improve-refs',
            'main',
        );

        expect(codeManagementService.addReactionToComment).toHaveBeenCalled();
        expect(codeManagementService.createIssueComment).toHaveBeenCalled();
        expect(businessValidationService.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                door: 'command',
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                taskInput:
                    'https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                pullRequest: expect.objectContaining({
                    number: 132,
                    body: 'PR description body',
                    headRef: 'feature/improve-refs',
                    baseRef: 'main',
                }),
            }),
        );
        expect(codeManagementService.addReactionToComment).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                },
                prNumber: 132,
                commentId: 123,
            }),
        );
        expect(codeManagementService.createIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                },
                prNumber: 132,
                body: '## 🤔 Tarefa não encontrada',
            }),
        );
        expect(
            codeManagementService.removeReactionsFromComment,
        ).toHaveBeenCalled();
    });
});
