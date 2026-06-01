import { createBusinessRulesBlueprint } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/blueprint';
import { classifyTaskQualityFromSources } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/blueprint.tooling';
import { BusinessRulesContext } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/types';
import { SkillCapabilityRuntimeConfig } from '@libs/agents/skills/generic-skill-runner.service';
import { CapabilityStrategyScope } from '@libs/agents/skills/runtime/skill-runtime.types';
import { runBlueprint } from '@libs/shared/blueprint/blueprint.runner';

const defaultRuntimeConfig: SkillCapabilityRuntimeConfig = {
    capabilities: ['pr.metadata.read', 'pr.diff.read', 'task.context.read'],
    allowedTools: ['KODUS_GET_PULL_REQUEST', 'KODUS_GET_PULL_REQUEST_DIFF'],
    fetcherPolicy: {
        toolMode: 'any',
        allowWithoutTools: false,
    },
    providerType: 'jira',
};

describe('business-rules blueprint', () => {
    it('classifies normalized task context with acceptance criteria as COMPLETE', () => {
        expect(
            classifyTaskQualityFromSources({
                taskContext:
                    'Task ID: APP-789\n\nTitle: Melhorar fluxo de onboarding\n\nDescription:\nAdicionar início de onboarding.\n\nAcceptance Criteria:\n- Usuário pode iniciar o onboarding\n- Checklist inicial é retornado',
                taskContextNormalized: {
                    id: 'APP-789',
                    title: 'Melhorar fluxo de onboarding',
                    description: 'Adicionar início de onboarding.',
                    acceptanceCriteria: [
                        'Usuário pode iniciar o onboarding',
                        'Checklist inicial é retornado',
                    ],
                },
            }),
        ).toBe('COMPLETE');
    });

    it('does not classify normalized task context without acceptance criteria as COMPLETE', () => {
        expect(
            classifyTaskQualityFromSources({
                taskContext:
                    'Task ID: APP-790\n\nTitle: Melhorar fluxo de onboarding\n\nDescription:\nAdicionar início de onboarding e tornar os primeiros passos mais previsíveis para novos usuários.',
                taskContextNormalized: {
                    id: 'APP-790',
                    title: 'Melhorar fluxo de onboarding',
                    description:
                        'Adicionar início de onboarding e tornar os primeiros passos mais previsíveis para novos usuários.',
                },
            }),
        ).toBe('PARTIAL');
    });

    it('uses preloaded PR metadata and still fetches diff deterministically', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST') {
                    return Promise.resolve({
                        result: {
                            result: {
                                success: true,
                                data: { body: 'PR body from tool' },
                            },
                        },
                    });
                }

                return Promise.resolve({
                    result: { result: { success: true, data: 'diff content' } },
                });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST' },
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                ]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn().mockResolvedValue(undefined),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        const ctx = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                userQuestion: 'validate',
                pullRequestDescription: 'PR body',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 10 },
                taskContext:
                    'As a user, I need to complete checkout with validation rules.',
            },
        } as BusinessRulesContext;

        if (!deterministicSteps.length) {
            throw new Error('deterministic steps not found');
        }

        let next = ctx;
        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callTool).toHaveBeenCalledTimes(1);
        expect(fetcher.callTool).toHaveBeenNthCalledWith(
            1,
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.objectContaining({
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'my-repo',
                prNumber: 10,
            }),
        );
        expect(fetcher.callAgent).not.toHaveBeenCalled();
        expect(next.prDiff).toBe('diff content');
        expect(next.prBody).toBe('PR body');
        expect(next.taskQuality).toBe('MINIMAL');
    });

    it('stringifies numeric repository ids before calling PR diff capability', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
        );
        const diffStep = steps.find(
            (step) =>
                step.type === 'deterministic' &&
                step.name === 'fetchPullRequestDiff',
        );

        if (!diffStep || diffStep.type !== 'deterministic') {
            throw new Error('fetchPullRequestDiff step not found');
        }

        const next = await diffStep.fn({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                repository: {
                    id: 123456 as unknown as string,
                    name: 'my-repo',
                },
                pullRequest: { pullRequestNumber: 12 },
            },
        } as BusinessRulesContext);

        expect(fetcher.callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.objectContaining({
                repositoryId: '123456',
                prNumber: 12,
            }),
        );
        expect(next.prDiff).toBe('diff content');
    });

    it('accepts legacy top-level pullRequestNumber in prepareContext', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
        );
        const diffStep = steps.find(
            (step) =>
                step.type === 'deterministic' &&
                step.name === 'fetchPullRequestDiff',
        );

        if (!diffStep || diffStep.type !== 'deterministic') {
            throw new Error('fetchPullRequestDiff step not found');
        }

        const next = await diffStep.fn({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                repository: {
                    id: 'repo-legacy',
                    name: 'my-repo',
                },
                pullRequestNumber: 44,
            },
        } as BusinessRulesContext);

        expect(fetcher.callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.objectContaining({
                repositoryId: 'repo-legacy',
                prNumber: 44,
            }),
        );
        expect(next.prDiff).toBe('diff content');
    });

    it('fetches metadata via MCP when PR description is not preloaded', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST') {
                    return Promise.resolve({
                        result: {
                            result: {
                                success: true,
                                data: { body: 'PR body from tool' },
                            },
                        },
                    });
                }

                return Promise.resolve({
                    result: { result: { success: true, data: 'diff content' } },
                });
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST' },
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                ]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn().mockResolvedValue(undefined),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 12 },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callTool).toHaveBeenNthCalledWith(
            1,
            'KODUS_GET_PULL_REQUEST',
            expect.any(Object),
        );
        expect(next.prBody).toBe('PR body from tool');
    });

    it('uses fetched PR body as hint source to resolve task context when prepareContext has no PR description', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string, args) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST') {
                    return Promise.resolve({
                        result: {
                            result: {
                                success: true,
                                data: {
                                    body: 'Task link: https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1457',
                                },
                            },
                        },
                    });
                }

                if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                    return Promise.resolve({
                        result: { result: { success: true, data: 'diff' } },
                    });
                }

                if (
                    toolName === 'getJiraIssue' &&
                    Object.values(args as Record<string, unknown>).includes(
                        'KC-1457',
                    )
                ) {
                    return Promise.resolve({
                        result: {
                            data: {
                                key: 'KC-1457',
                                fields: {
                                    summary: 'Business rule task',
                                    description:
                                        'Validate mandatory fields and checkout rules.',
                                },
                            },
                        },
                    });
                }

                return Promise.resolve({ result: {} });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST' },
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                    { name: 'getJiraIssue' },
                ]),
            getToolsForLLM: jest.fn().mockReturnValue([
                {
                    name: 'getJiraIssue',
                    parameters: {
                        type: 'object',
                        properties: {
                            cloudId: { type: 'string' },
                            issueIdOrKey: { type: 'string' },
                        },
                        required: ['cloudId', 'issueIdOrKey'],
                    },
                },
            ]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn().mockResolvedValue(undefined),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 77 },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(next.prBody).toContain('selectedIssue=KC-1457');
        expect(next.taskContext).toContain('Business rule task');
        expect(fetcher.callAgent).not.toHaveBeenCalled();
    });

    it('falls back to prepareContext PR description when metadata tool is unavailable', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn().mockResolvedValue(undefined),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription: 'PR body from prepare context',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 12 },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callTool).toHaveBeenCalledTimes(1);
        expect(fetcher.callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.any(Object),
        );
        expect(next.prBody).toBe('PR body from prepare context');
    });

    it('skips metadata tool call when metadata capability is not configured', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const runtimeConfig: SkillCapabilityRuntimeConfig = {
            ...defaultRuntimeConfig,
            capabilities: ['pr.diff.read', 'task.context.read'],
            allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
        };

        const steps = createBusinessRulesBlueprint(fetcher, runtimeConfig);
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription: 'PR description from prepare context',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 13 },
                taskContext: 'Task context payload',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callTool).toHaveBeenCalledTimes(1);
        expect(fetcher.callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.any(Object),
        );
        expect(next.prBody).toBe('PR description from prepare context');
    });

    it('fetches task context deterministically from Jira tools when task context is not preloaded', async () => {
        const fetcher = {
            callTool: jest
                .fn()
                .mockImplementation((toolName: string, _args?: unknown) => {
                    if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                        return Promise.resolve({
                            result: {
                                result: { success: true, data: 'diff content' },
                            },
                        });
                    }

                    if (
                        toolName === 'getJiraIssue' &&
                        (_args as Record<string, unknown>)?.cloudId ===
                            'https://kodustech.atlassian.net' &&
                        (_args as Record<string, unknown>)?.issueIdOrKey ===
                            'PROJ-123'
                    ) {
                        return Promise.resolve({
                            result: {
                                data: {
                                    key: 'PROJ-123',
                                    fields: {
                                        summary: 'Checkout validation',
                                        description:
                                            'Need to validate payment rules and edge cases.',
                                        acceptanceCriteria: [
                                            'Reject invalid card',
                                            'Handle timeout retries',
                                        ],
                                    },
                                },
                            },
                        });
                    }

                    return Promise.resolve({ result: {} });
                }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                    { name: 'getJiraIssue' },
                    { name: 'fetch' },
                ]),
            getToolsForLLM: jest.fn().mockReturnValue([
                {
                    name: 'getJiraIssue',
                    parameters: {
                        type: 'object',
                        properties: {
                            cloudId: { type: 'string' },
                            issueIdOrKey: { type: 'string' },
                        },
                        required: ['cloudId', 'issueIdOrKey'],
                    },
                },
                {
                    name: 'fetch',
                    parameters: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                        required: ['id'],
                    },
                },
            ]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn().mockResolvedValue(undefined),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription:
                    'Implements checkout validation. Related to https://kodustech.atlassian.net/jira/software/c/projects/PROJ/boards/1?selectedIssue=PROJ-123.',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: {
                    pullRequestNumber: 22,
                    headRef: 'feature/PROJ-123',
                },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        const taskToolCall = fetcher.callTool.mock.calls.find(
            (call: unknown[]) => call[0] === 'getJiraIssue',
        );
        expect(taskToolCall).toBeDefined();
        expect((taskToolCall as unknown[])[1]).toEqual(
            expect.objectContaining({
                cloudId: 'https://kodustech.atlassian.net',
                issueIdOrKey: 'PROJ-123',
            }),
        );
        expect(next.taskContext).toContain('Checkout validation');
        expect(next.taskContext).toContain('Reject invalid card');
        expect(next.taskQuality).toBe('COMPLETE');
        expect(
            fetcher.callTool.mock.calls.some(
                (call: unknown[]) => call[0] === 'fetch',
            ),
        ).toBe(false);
        expect(
            next.capabilityExecutionTrace?.some(
                (trace) =>
                    trace.capability === 'task.context.read' &&
                    trace.status === 'success',
            ),
        ).toBe(true);
    });

    it('uses agentic fallback for task context when no deterministic task tool is registered', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            callAgent: jest.fn().mockResolvedValue({
                result: JSON.stringify({
                    taskContext:
                        'Task: Validate business rules for checkout and timeout behavior.',
                    title: 'Checkout business validation',
                    issueKey: 'PROJ-999',
                    toolsUsed: ['search'],
                }),
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription:
                    'Implements checkout validation. Related to PROJ-999.',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 23 },
                taskContext: '',
                enableAgenticFallback: true,
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callAgent).toHaveBeenCalledTimes(1);
        expect(next.taskContext).toContain('Checkout business validation');
        expect(
            next.capabilityExecutionTrace?.some(
                (trace) =>
                    trace.mode === 'agentic' && trace.toolName === 'search',
            ),
        ).toBe(true);
    });

    it('enforces seeded task-context boundary before applying cache ordering', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                    return Promise.resolve({
                        result: {
                            result: { success: true, data: 'diff content' },
                        },
                    });
                }

                if (toolName === 'search') {
                    return Promise.resolve({ result: { data: {} } });
                }

                if (toolName === 'getJiraIssue') {
                    return Promise.resolve({
                        result: {
                            data: {
                                key: 'PROJ-700',
                                fields: {
                                    summary: 'Known seeded strategy task',
                                    description:
                                        'Loaded from seeded plan after cache miss',
                                },
                            },
                        },
                    });
                }

                return Promise.resolve({ result: { data: {} } });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                    { name: 'search' },
                    { name: 'getJiraIssue' },
                ]),
            getToolsForLLM: jest.fn().mockReturnValue([
                {
                    name: 'search',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query'],
                    },
                },
                {
                    name: 'getJiraIssue',
                    parameters: {
                        type: 'object',
                        properties: {
                            cloudId: { type: 'string' },
                            issueIdOrKey: { type: 'string' },
                        },
                        required: ['cloudId', 'issueIdOrKey'],
                    },
                },
            ]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue(['search']),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn(),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription:
                    'Related to https://kodustech.atlassian.net/jira/software/c/projects/PROJ/boards/1?selectedIssue=PROJ-700',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 24 },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        const taskToolsCalls = fetcher.callTool.mock.calls
            .map((call: unknown[]) => call[0])
            .filter(
                (toolName: unknown) =>
                    toolName === 'search' || toolName === 'getJiraIssue',
            );

        expect(taskToolsCalls[0]).toBe('getJiraIssue');
        expect(taskToolsCalls).not.toContain('search');
        expect(next.taskContext).toContain('Known seeded strategy task');
    });

    it('supports agent-first mode and saves learned tools to cache hook', async () => {
        const fetcher = {
            callTool: jest.fn().mockResolvedValue({
                result: { result: { success: true, data: 'diff content' } },
            }),
            callAgent: jest.fn().mockResolvedValue({
                result: JSON.stringify({
                    taskContext: 'Agent discovered task context',
                    title: 'Agent title',
                    toolsUsed: ['search'],
                }),
            }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                    { name: 'search' },
                ]),
            getToolsForLLM: jest.fn().mockReturnValue([
                {
                    name: 'search',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string' } },
                        required: ['query'],
                    },
                },
            ]),
        } as any;

        const saveCachedTaskContextTools = jest
            .fn()
            .mockResolvedValue(undefined);

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest.fn().mockResolvedValue([]),
            resolveTaskContextMode: jest.fn().mockReturnValue('agent_first'),
            saveCachedTaskContextTools,
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription: 'Related to PROJ-701',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 25 },
                taskContext: '',
                enableAgenticFallback: true,
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(fetcher.callAgent).toHaveBeenCalledTimes(1);
        expect(saveCachedTaskContextTools).toHaveBeenCalledWith(
            expect.objectContaining<CapabilityStrategyScope>({
                capability: 'task.context.read',
            }),
            expect.arrayContaining(['search']),
        );
        expect(next.taskContext).toContain('Agent discovered task context');
    });

    it('blocks write tools in deterministic task.context.read via explicit allowlist', async () => {
        const fetcher = {
            callTool: jest
                .fn()
                .mockImplementation((toolName: string, _args?: unknown) => {
                    if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                        return Promise.resolve({
                            result: {
                                result: { success: true, data: 'diff content' },
                            },
                        });
                    }

                    if (toolName === 'getJiraIssue') {
                        return Promise.resolve({
                            result: {
                                data: {
                                    key: 'PROJ-321',
                                    fields: {
                                        summary: 'Read-only tool selected',
                                        description:
                                            'Tool boundary blocked write tools.',
                                    },
                                },
                            },
                        });
                    }

                    return Promise.resolve({ result: {} });
                }),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([
                    { name: 'KODUS_GET_PULL_REQUEST_DIFF' },
                    { name: 'editJiraIssue' },
                    { name: 'getJiraIssue' },
                ]),
            getToolsForLLM: jest.fn().mockReturnValue([
                {
                    name: 'editJiraIssue',
                    parameters: {
                        type: 'object',
                        properties: {
                            cloudId: { type: 'string' },
                            issueIdOrKey: { type: 'string' },
                            fields: { type: 'string' },
                        },
                        required: ['cloudId', 'issueIdOrKey', 'fields'],
                    },
                },
                {
                    name: 'getJiraIssue',
                    parameters: {
                        type: 'object',
                        properties: {
                            cloudId: { type: 'string' },
                            issueIdOrKey: { type: 'string' },
                        },
                        required: ['cloudId', 'issueIdOrKey'],
                    },
                },
            ]),
        } as any;

        const hooks = {
            getCachedTaskContextTools: jest.fn().mockResolvedValue([]),
            getSeedTaskContextTools: jest
                .fn()
                .mockResolvedValue(['getJiraIssue']),
            resolveTaskContextMode: jest.fn().mockReturnValue('cache_first'),
            saveCachedTaskContextTools: jest.fn().mockResolvedValue(undefined),
            resolvePreferredTool: jest.fn().mockResolvedValue(undefined),
            recordExecution: jest.fn().mockResolvedValue(undefined),
        };

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
            hooks,
        );
        const deterministicSteps = steps.filter(
            (step) => step.type === 'deterministic',
        );

        let next = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            userLanguage: 'en-US',
            prepareContext: {
                pullRequestDescription:
                    'Related to https://kodustech.atlassian.net/browse/PROJ-321',
                repository: { id: 'repo-1', name: 'my-repo' },
                pullRequest: { pullRequestNumber: 26 },
                taskContext: '',
            },
        } as BusinessRulesContext;

        for (const step of deterministicSteps) {
            next = await step.fn(next);
        }

        expect(
            fetcher.callTool.mock.calls.some(
                (call: unknown[]) => call[0] === 'editJiraIssue',
            ),
        ).toBe(false);
        expect(next.taskContext).toContain('Read-only tool selected');
    });

    it('short-circuits before analysis when the PR diff is empty', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                    return Promise.resolve({
                        result: { result: { success: true, data: '' } },
                    });
                }

                return Promise.resolve({ result: {} });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
        );

        const result = await runBlueprint<BusinessRulesContext>({
            context: {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                userLanguage: 'en-US',
                prepareContext: {
                    pullRequestDescription:
                        'Implements billing lookup updates for the selected workspace.',
                    repository: { id: 'repo-1', name: 'my-repo' },
                    pullRequest: { pullRequestNumber: 31 },
                    taskContext:
                        'Kody rules por time. Atualmente as kodyRules sao cadastradas somente com organizationId e isso faz com que o billing possa ser resolvido no team errado quando existem dois workspaces configurados.',
                },
            } as BusinessRulesContext,
            steps,
            runLLMStep: async (_step, ctx) => ({
                ...ctx,
                formattedResponse: 'analyzer should not run',
            }),
        });

        expect(result.skippedAt).toBe('validatePullRequestDiff');
        expect(fetcher.callTool).toHaveBeenCalledWith(
            'KODUS_GET_PULL_REQUEST_DIFF',
            expect.any(Object),
        );
        expect(result.context.validationResult).toEqual(
            expect.objectContaining({
                needsMoreInfo: true,
                mode: 'limitation_response',
                reason: 'pr_diff_missing',
                prDiffStatus: 'missing',
                taskContextStatus: 'usable',
            }),
        );
        expect(result.context.analysisEligibility).toEqual(
            expect.objectContaining({
                mode: 'limitation_response',
                reason: 'pr_diff_missing',
                prDiffStatus: 'missing',
                taskContextStatus: 'usable',
            }),
        );
        expect(result.context.formattedResponse).toBeUndefined();
        expect(result.context.validationResult?.summary).toContain(
            'pull request diff',
        );
    });

    it('returns a limitation outcome when task context is too weak even if the diff is available', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                    return Promise.resolve({
                        result: {
                            result: {
                                success: true,
                                data: 'diff --git a/file.ts b/file.ts',
                            },
                        },
                    });
                }

                return Promise.resolve({ result: {} });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
        );

        const result = await runBlueprint<BusinessRulesContext>({
            context: {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                userLanguage: 'en-US',
                prepareContext: {
                    pullRequestDescription: 'PR body',
                    repository: { id: 'repo-1', name: 'my-repo' },
                    pullRequest: { pullRequestNumber: 33 },
                    taskContext: 'KC-1441 — Kody rules por time',
                },
            } as BusinessRulesContext,
            steps,
            runLLMStep: async () => {
                throw new Error('analyzer should not run');
            },
        });

        expect(result.skippedAt).toBe('validateTaskContext');
        expect(result.context.validationResult).toEqual(
            expect.objectContaining({
                needsMoreInfo: true,
                mode: 'limitation_response',
                reason: 'task_context_weak',
                taskContextStatus: 'weak',
                prDiffStatus: 'missing',
            }),
        );
        expect(result.context.formattedResponse).toBeUndefined();
        expect(result.context.validationResult?.summary).toContain(
            'Insufficient Task Context',
        );
    });

    it('allows analysis to run when PR diff has surrounding whitespace', async () => {
        const fetcher = {
            callTool: jest.fn().mockImplementation((toolName: string) => {
                if (toolName === 'KODUS_GET_PULL_REQUEST_DIFF') {
                    return Promise.resolve({
                        result: {
                            result: {
                                success: true,
                                data: '  diff --git a/file.ts b/file.ts  ',
                            },
                        },
                    });
                }

                return Promise.resolve({ result: {} });
            }),
            callAgent: jest.fn(),
            getRegisteredTools: jest
                .fn()
                .mockReturnValue([{ name: 'KODUS_GET_PULL_REQUEST_DIFF' }]),
        } as any;

        const steps = createBusinessRulesBlueprint(
            fetcher,
            defaultRuntimeConfig,
        );

        const result = await runBlueprint<BusinessRulesContext>({
            context: {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                userLanguage: 'en-US',
                prepareContext: {
                    pullRequestDescription: 'PR body',
                    repository: { id: 'repo-1', name: 'my-repo' },
                    pullRequest: { pullRequestNumber: 32 },
                    taskContext:
                        'Kody rules por time. Billing must respect the selected workspace team, the lookup must not leak billing state from a different workspace, and acceptance must verify the rule creation flow when multiple teams exist in the same organization.',
                },
            } as BusinessRulesContext,
            steps,
            runLLMStep: async (_step, ctx) => ({
                ...ctx,
                validationResult: {
                    needsMoreInfo: false,
                    mode: 'full_analysis',
                    reason: 'analysis_ready',
                    taskContextStatus: 'usable',
                    prDiffStatus: 'usable',
                    summary: 'ok',
                },
                formattedResponse: 'ok',
            }),
        });

        expect(result.completedSteps).toContain('analyzeBusinessRules');
        expect(result.context.validationResult).toEqual(
            expect.objectContaining({
                needsMoreInfo: false,
                mode: 'full_analysis',
                reason: 'analysis_ready',
                taskContextStatus: 'usable',
                prDiffStatus: 'usable',
                summary: 'ok',
            }),
        );
        expect(result.context.analysisEligibility).toEqual(
            expect.objectContaining({
                mode: 'full_analysis',
                reason: 'analysis_ready',
                taskContextStatus: 'usable',
                prDiffStatus: 'usable',
            }),
        );
    });
});
