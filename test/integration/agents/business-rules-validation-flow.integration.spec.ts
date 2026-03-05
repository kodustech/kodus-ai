import { BusinessRulesValidationAgentUseCase } from '@libs/agents/application/use-cases/business-rules-validation-agent.use-case';
import { buildBusinessRulesAnalysisPrompt } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/analysis-prompt.builder';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { BaseAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/base-agent.provider';
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

describe('BusinessRulesValidation flow integration', () => {
    const organizationAndTeamData = {
        organizationId: 'org-integration',
        teamId: 'team-integration',
    };

    let provider: BusinessRulesValidationAgentProvider;
    let useCase: BusinessRulesValidationAgentUseCase;
    let analyzerAdapter: { call: jest.Mock };
    let genericSkillRunner: {
        createFetcherOrchestration: jest.Mock;
        getExecutionPolicy: jest.Mock;
        getAnalyzerInstructions: jest.Mock;
    };
    let permissionValidationService: {
        getBYOKConfig: jest.Mock;
    };
    let parametersService: {
        findByKey: jest.Mock;
    };
    let metricsCollector: {
        recordCounter: jest.Mock;
        recordHistogram: jest.Mock;
    };

    beforeEach(() => {
        jest.restoreAllMocks();
        analyzerAdapter = {
            call: jest.fn(),
        };
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
        permissionValidationService = {
            getBYOKConfig: jest.fn().mockResolvedValue(undefined),
        };
        parametersService = {
            findByKey: jest.fn().mockResolvedValue({ configValue: 'pt-BR' }),
        };
        metricsCollector = {
            recordCounter: jest.fn(),
            recordHistogram: jest.fn(),
        };

        provider = new BusinessRulesValidationAgentProvider(
            {} as any,
            permissionValidationService as any,
            parametersService as any,
            {} as any,
            genericSkillRunner as any,
            metricsCollector as any,
        );
        jest.spyOn(
            BaseAgentProvider.prototype as any,
            'createLLMAdapter',
        ).mockReturnValue(analyzerAdapter);

        useCase = new BusinessRulesValidationAgentUseCase(provider);
    });

    it('executes the full business-logic flow and passes skill instructions plus localized prompt to the analyzer', async () => {
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
        const runLLMStepSpy = jest
            .spyOn(provider as any, 'runLLMStep')
            .mockImplementation(async (_step: unknown, ctx: any) => {
                const prompt = buildBusinessRulesAnalysisPrompt(ctx);

                expect(ctx.userLanguage).toBe('pt-BR');
                expect(ctx.taskQuality).toBe('COMPLETE');
                expect(ctx.analysisEligibility).toMatchObject({
                    mode: 'full_analysis',
                    reason: 'analysis_ready',
                    taskContextStatus: 'usable',
                    prDiffStatus: 'usable',
                });
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
            });

        analyzerAdapter.call.mockResolvedValue({
            content: {
                needsMoreInfo: false,
                mode: 'full_analysis',
                reason: 'analysis_ready',
                taskContextStatus: 'usable',
                prDiffStatus: 'usable',
                confidence: 'medium',
                summary: '## Validação de Regras de Negócio\n\nTudo certo.',
            },
            usage: {
                promptTokens: 100,
                completionTokens: 50,
                totalTokens: 150,
            },
        });

        const result = await useCase.execute({
            organizationAndTeamData,
            prepareContext: {
                userQuestion:
                    '@kody -v business-logic https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                },
                pullRequest: {
                    pullRequestNumber: 132,
                },
            },
        });

        expect(runLLMStepSpy).toHaveBeenCalledTimes(1);
        expect(result).toContain('Validação de Regras de Negócio');
    });

    it('short-circuits with limitation feedback when PR diff is missing and never calls the analyzer', async () => {
        genericSkillRunner.createFetcherOrchestration.mockResolvedValue({
            toolCaller: createMockToolCaller({
                prBody: 'Attempts to fix billing lookup by team.',
                prDiff: '',
                task: {
                    id: 'KC-1441',
                    title: 'Kody rules por time',
                    description:
                        'Atualmente as kodyRules são cadastradas somente com organizationId. Billing e licença precisam respeitar o time correto.',
                    acceptanceCriteria: [
                        'Kody rules must be scoped by team, not only organization',
                        'Billing resolution must use the correct team context',
                    ],
                },
            }),
            capabilityRuntime: createCapabilityRuntime(),
        });
        const runLLMStepSpy = jest.spyOn(provider as any, 'runLLMStep');

        const result = await useCase.execute({
            organizationAndTeamData,
            prepareContext: {
                userQuestion: '@kody -v business-logic KC-1441',
                repository: {
                    id: 'repo-1',
                    name: 'kodus-extension',
                },
                pullRequest: {
                    pullRequestNumber: 132,
                },
            },
        });

        expect(result).toContain('Need Pull Request Diff');
        expect(result).toContain("I couldn't load the pull request diff");
        expect(runLLMStepSpy).not.toHaveBeenCalled();
    });
});
