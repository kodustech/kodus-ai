jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
    createThreadId: jest.fn(() => ({
        id: 'TR-vbl-integration',
        metadata: {},
    })),
}));

import { BusinessRulesValidationAgentUseCase } from '@libs/agents/application/use-cases/business-rules-validation-agent.use-case';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { buildBusinessRulesAnalysisPrompt } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/analysis-prompt.builder';
import { BaseAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/base-agent.provider';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { ChatWithKodyFromGitUseCase } from '@libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case';
import {
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from '@libs/agents/skills/runtime/skill-runtime.types';

function createMockToolCaller(params: {
    prBody: string;
    prDiff: string;
    task: {
        id: string;
        title: string;
        description: string;
        acceptanceCriteria?: string[];
    };
    taskContextToolName?: string;
}): ToolCaller {
    const taskContextToolName = params.taskContextToolName ?? 'getJiraIssue';

    return {
        callTool: async (toolName: string) => {
            if (toolName === 'KODUS_GET_PULL_REQUEST') {
                return {
                    result: {
                        data: {
                            body: params.prBody,
                        },
                    },
                };
            }

            if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                return {
                    result: {
                        data: params.prDiff,
                    },
                };
            }

            if (toolName === taskContextToolName) {
                return {
                    result: {
                        data: {
                            key: params.task.id,
                            fields: {
                                summary: params.task.title,
                                description: params.task.description,
                                acceptanceCriteria:
                                    params.task.acceptanceCriteria,
                            },
                        },
                    },
                };
            }

            return { result: {} };
        },
        getRegisteredTools: () => [
            { name: 'KODUS_GET_PULL_REQUEST' },
            { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
            { name: taskContextToolName },
        ],
        getToolsForLLM: () => [
            {
                name: taskContextToolName,
                parameters: {
                    required: ['issueIdOrKey'],
                    properties: {
                        issueIdOrKey: {
                            type: 'string',
                            description: 'Issue key (e.g. KC-1441)',
                        },
                    },
                },
            },
        ],
    };
}

function createCapabilityRuntime(
    providerType = 'jira',
    taskContextToolName = 'getJiraIssue',
): SkillCapabilityRuntimeConfig {
    return {
        capabilities: ['pr.metadata.read', 'pr.diff.read', 'task.context.read'],
        allowedTools: [
            'KODUS_GET_PULL_REQUEST',
            'KODUS_GET_PULL_REQUEST_DIFF',
            taskContextToolName,
        ],
        capabilityToolMap: {
            'pr.metadata.read': ['KODUS_GET_PULL_REQUEST'],
            'pr.diff.read': ['KODUS_GET_PULL_REQUEST_DIFF'],
            'task.context.read': [taskContextToolName],
        },
        fetcherPolicy: {
            toolMode: 'any',
            allowWithoutTools: false,
        },
        providerType,
        allProviderTypes: [providerType],
    };
}

describe('ChatWithKodyFromGitUseCase business-logic integration', () => {
    let chatUseCase: ChatWithKodyFromGitUseCase;
    let provider: BusinessRulesValidationAgentProvider;
    let businessRulesUseCaseExecuteSpy: jest.SpyInstance;
    let genericSkillRunner: {
        createFetcherOrchestration: jest.Mock;
        getExecutionPolicy: jest.Mock;
        getAnalyzerInstructions: jest.Mock;
    };
    let codeManagementService: {
        findTeamAndOrganizationIdByConfigKey: jest.Mock;
        addReactionToComment: jest.Mock;
        createIssueComment: jest.Mock;
        removeReactionsFromComment: jest.Mock;
    };

    beforeEach(() => {
        jest.restoreAllMocks();

        genericSkillRunner = {
            createFetcherOrchestration: jest.fn(),
            getExecutionPolicy: jest.fn(() => ({
                analyzerTimeoutMs: 5_000,
                analyzerMaxIterations: 1,
                fetcherTimeoutMs: 5_000,
                fetcherMaxIterations: 1,
                onMissingMcp: 'fail',
                onMcpConnectError: 'fail',
            })),
            getAnalyzerInstructions: jest.fn(() => 'SYSTEM SKILL INSTRUCTIONS'),
        };

        provider = new BusinessRulesValidationAgentProvider(
            {} as any,
            { getBYOKConfig: jest.fn().mockResolvedValue(undefined) } as any,
            {
                findByKey: jest
                    .fn()
                    .mockResolvedValue({ configValue: 'pt-BR' }),
            } as any,
            {} as any,
            genericSkillRunner as any,
            {
                recordCounter: jest.fn(),
                recordHistogram: jest.fn(),
            } as any,
        );

        jest.spyOn(
            BaseAgentProvider.prototype as any,
            'createLLMAdapter',
        ).mockReturnValue({
            call: jest.fn(),
        });

        genericSkillRunner.createFetcherOrchestration.mockResolvedValue({
            toolCaller: createMockToolCaller({
                prBody: 'Refines type-safety in extension commands.',
                prDiff: 'diff --git a/src/commands/prCommentCommands.ts b/src/commands/prCommentCommands.ts\n+ changeGroups.forEach((change: GitChangeLike) => {\n',
                task: {
                    id: 'KC-1441',
                    title: 'Replace any-based git change parsing with typed handling',
                    description:
                        'The PR should remove unsafe any usage from git change collection and preserve command behavior. The business requirement is to keep PR comment context collection stable while tightening type-safety.',
                    acceptanceCriteria: [
                        'Git change parsing no longer relies on any',
                        'PR comment validation keeps collecting changed files for review context',
                    ],
                },
            }),
            capabilityRuntime: createCapabilityRuntime(),
        });

        jest.spyOn(provider as any, 'runLLMStep').mockImplementation(
            async (_step: unknown, ctx: any) => {
                const prompt = buildBusinessRulesAnalysisPrompt(ctx);
                expect(prompt).toContain('USER LANGUAGE: pt-BR');
                expect(prompt).toContain('TASK: KC-1441');
                expect(prompt).toContain('PR_DIFF:');

                return {
                    ...ctx,
                    validationResult: {
                        needsMoreInfo: false,
                        mode: 'full_analysis',
                        reason: 'analysis_ready',
                        taskContextStatus: 'usable',
                        prDiffStatus: 'usable',
                        confidence: 'medium',
                        summary:
                            '## Validação de Regras de Negócio\n\nTudo certo.',
                    },
                    formattedResponse:
                        '## Validação de Regras de Negócio\n\nTudo certo.',
                };
            },
        );
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

        businessRulesUseCaseExecuteSpy = jest.spyOn(
            BusinessRulesValidationAgentUseCase.prototype,
            'execute',
        );
        const businessRulesValidationUseCase =
            new BusinessRulesValidationAgentUseCase(provider);

        chatUseCase = new ChatWithKodyFromGitUseCase(
            codeManagementService as any,
            { execute: jest.fn() } as any,
            businessRulesValidationUseCase,
        );
    });

    it('handles the business-logic flow through the real business-rules provider', async () => {
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
        expect(businessRulesUseCaseExecuteSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                prepareContext: expect.objectContaining({
                    userQuestion:
                        '@kody -v business-logic https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                    pullRequestDescription: 'PR description body',
                    pullRequest: expect.objectContaining({
                        pullRequestNumber: 132,
                        headRef: 'feature/improve-refs',
                        baseRef: 'main',
                    }),
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
                body: '## Validação de Regras de Negócio\n\nTudo certo.',
            }),
        );
        expect(
            codeManagementService.removeReactionsFromComment,
        ).toHaveBeenCalled();
    });
});
