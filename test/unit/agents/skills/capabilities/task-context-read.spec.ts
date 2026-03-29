import { fetchTaskContext } from '@libs/agents/skills/capabilities/task-context-read';
import {
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from '@libs/agents/skills/runtime/skill-runtime.types';

type CallToolMock = jest.Mock<
    ReturnType<ToolCaller['callTool']>,
    Parameters<ToolCaller['callTool']>
>;
type CallAgentMock = jest.Mock<
    ReturnType<NonNullable<ToolCaller['callAgent']>>,
    Parameters<NonNullable<ToolCaller['callAgent']>>
>;

function createCapabilityRuntime(
    providerType = 'external',
): SkillCapabilityRuntimeConfig {
    return {
        capabilities: ['task.context.read'],
        allowedTools: ['searchTasks', 'getIssue', 'editTask'],
        capabilityToolMap: {
            'task.context.read': ['searchTasks', 'getIssue'],
        },
        fetcherPolicy: {
            toolMode: 'any',
            allowWithoutTools: false,
        },
        providerType,
        allProviderTypes: [providerType],
    };
}

function createBaseParams() {
    return {
        skillName: 'business-rules-validation',
        organizationId: 'org-1',
        teamId: 'team-1',
        userQuestion: '@kody TASK-1',
        pullRequestDescription: 'Related to TASK-1',
        prBody: 'PR text TASK-1',
        taskContextResolutionMode: 'cache_first' as const,
        enableAgenticFallback: true,
    };
}

describe('fetchTaskContext capability', () => {
    it('resolves context deterministically and respects seeded boundary', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                data: {
                    key: 'TASK-1',
                    fields: {
                        summary: 'Task title',
                        description: 'Task description',
                    },
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [
                { name: 'searchTasks' },
                { name: 'editTask' },
            ],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['searchTasks']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('linear'),
            createBaseParams(),
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: 'TASK-1',
            title: 'Task title',
            description: 'Task description',
            sourceProvider: 'linear',
        });
        expect(result.traces.some((trace) => trace.status === 'success')).toBe(
            true,
        );
        expect(callTool).toHaveBeenCalled();
        expect(
            callTool.mock.calls.some(([toolName]) => toolName === 'editTask'),
        ).toBe(false);
    });

    it('falls back to agent when deterministic candidates are empty', async () => {
        const callAgent: CallAgentMock = jest.fn().mockResolvedValue({
            result: JSON.stringify({
                taskContext: 'Agent context',
                title: 'Agent title',
                id: 'AG-1',
                toolsUsed: ['search'],
            }),
        });

        const toolCaller: ToolCaller = {
            callTool: jest.fn(),
            callAgent,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => []),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('notion'),
            {
                ...createBaseParams(),
                taskContextResolutionMode: 'agent_first',
            },
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: 'AG-1',
            title: 'Agent title',
            description: 'Agent context',
            sourceProvider: 'notion',
        });
        expect(callAgent).toHaveBeenCalled();
        expect(
            result.traces.some(
                (trace) =>
                    trace.mode === 'agentic' && trace.status === 'success',
            ),
        ).toBe(true);
    });

    it('explores registered deterministic tools when no seed boundary is available', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                data: {
                    key: 'TASK-9',
                    fields: {
                        summary: 'Explored task',
                        description: 'Resolved without seeded tools',
                    },
                },
            },
        });
        const callAgent: CallAgentMock = jest.fn();

        const toolCaller: ToolCaller = {
            callTool,
            callAgent,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => []),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            createBaseParams(),
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'searchTasks',
            expect.objectContaining({ query: 'TASK-1' }),
        );
        expect(callAgent).not.toHaveBeenCalled();
        expect(result.normalized).toMatchObject({
            id: 'TASK-9',
            title: 'Explored task',
            description: 'Resolved without seeded tools',
            sourceProvider: 'jira',
        });
    });

    it('uses structured business signals as additional deterministic hints', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                data: {
                    key: 'KC-1441',
                    fields: {
                        summary: 'Kody rules por time',
                        description: 'Resolved from structured signals',
                    },
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => []),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic',
                pullRequestDescription: 'General cleanup in extension commands',
                prBody: 'No direct ticket reference in the body',
                businessSignals: {
                    ticketKeys: ['KC-1441'],
                    taskLinks: [
                        'https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                    ],
                    requirementKeywords: ['acceptance criteria'],
                },
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'searchTasks',
            expect.objectContaining({ query: 'KC-1441' }),
        );
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Kody rules por time',
            description: 'Resolved from structured signals',
            sourceProvider: 'jira',
        });
    });

    it('matches seeded tool aliases against registered tool name variants', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                issue: {
                    id: 'issue-uuid-1',
                    identifier: 'KC-1441',
                    title: 'Kody rules por time',
                    description: 'Resolved from aliased Linear tool name.',
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'LINEAR_GET_LINEAR_ISSUE' }],
            getToolsForLLM: () => [
                {
                    name: 'LINEAR_GET_LINEAR_ISSUE',
                    parameters: {
                        required: ['id'],
                        properties: {
                            id: {
                                type: 'string',
                                description: 'Issue id or key',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => [
                'LINEAR_GET_LINEAR_ISSUE',
            ]),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('linear'),
            {
                ...createBaseParams(),
                userQuestion: '@kody KC-1441',
                pullRequestDescription: 'Related to KC-1441',
                prBody: 'PR text KC-1441',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'LINEAR_GET_LINEAR_ISSUE',
            expect.objectContaining({ id: 'KC-1441' }),
        );
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Kody rules por time',
            description: 'Resolved from aliased Linear tool name.',
            sourceProvider: 'linear',
        });
    });

    it('matches tool aliases even when the registered name includes provider qualifiers', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                task: {
                    id: '86d123',
                    name: 'Kody rules por time',
                    description: 'Resolved from provider-qualified tool name.',
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'Workspace CLICKUP_GET_TASK' }],
            getToolsForLLM: () => [
                {
                    name: 'Workspace CLICKUP_GET_TASK',
                    parameters: {
                        required: ['taskId'],
                        properties: {
                            taskId: { type: 'string', description: 'Task ID' },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['CLICKUP_GET_TASK']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('clickup'),
            {
                ...createBaseParams(),
                userQuestion: '@kody TASK-86',
                pullRequestDescription: 'Related to TASK-86',
                prBody: 'PR text TASK-86',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'Workspace CLICKUP_GET_TASK',
            expect.objectContaining({ taskId: 'TASK-86' }),
        );
        expect(result.normalized).toMatchObject({
            id: '86d123',
            title: 'Kody rules por time',
            description: 'Resolved from provider-qualified tool name.',
            sourceProvider: 'clickup',
        });
    });

    it('prefers issue key over internal numeric id when both are present in Jira payload', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                data: {
                    id: '15604',
                    key: 'KC-1441',
                    fields: {
                        summary: 'Kody rules por time',
                        description: 'Resolved from Jira issue payload',
                    },
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => []),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic KC-1441',
            },
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Kody rules por time',
            description: 'Resolved from Jira issue payload',
            sourceProvider: 'jira',
        });
    });

    it('skips when no deterministic candidates and agent fallback disabled', async () => {
        const toolCaller: ToolCaller = {
            callTool: jest.fn(),
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => []),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime(),
            {
                ...createBaseParams(),
                enableAgenticFallback: false,
            },
            hooks,
        );

        expect(result.normalized).toBeUndefined();
        expect(result.traces).toHaveLength(1);
        expect(result.traces[0]).toMatchObject({
            status: 'skipped',
            reason: 'no_candidate_tools',
            capability: 'task.context.read',
        });
    });

    it('avoids deterministic execution when required schema is non-string and uses agent fallback', async () => {
        const callTool: CallToolMock = jest.fn();
        const callAgent: CallAgentMock = jest.fn().mockResolvedValue({
            result: JSON.stringify({
                taskContext: 'Fallback context',
                toolsUsed: ['search'],
            }),
        });

        const toolCaller: ToolCaller = {
            callTool,
            callAgent,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['issue'],
                        properties: {
                            issue: {
                                type: 'object',
                                description: 'Complex object payload',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['searchTasks']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('clickup'),
            createBaseParams(),
            hooks,
        );

        expect(callTool).not.toHaveBeenCalled();
        expect(callAgent).toHaveBeenCalled();
        expect(result.normalized?.description).toBe('Fallback context');
    });

    it('extracts task context from provider payload embedded as JSON text content', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify({
                            id: 'PAGE-42',
                            properties: {
                                'Name': {
                                    title: [
                                        { plain_text: 'Notion Task Title' },
                                    ],
                                },
                                'Acceptance Criteria': {
                                    rich_text: [
                                        { plain_text: 'Must support flow X' },
                                    ],
                                },
                            },
                            description: {
                                rich_text: [
                                    {
                                        plain_text:
                                            'Detailed context from provider',
                                    },
                                ],
                            },
                            url: 'https://example.notion.site/PAGE-42',
                        }),
                    },
                ],
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['searchTasks']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('notion'),
            createBaseParams(),
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: 'PAGE-42',
            title: 'Notion Task Title',
            description: 'Detailed context from provider',
            acceptanceCriteria: ['Must support flow X'],
            sourceProvider: 'notion',
        });
    });

    it('extracts task context from a Linear issue-style payload', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                issue: {
                    id: 'issue-uuid-1',
                    identifier: 'KC-1441',
                    title: 'Kody rules por time',
                    description:
                        'Rules must be resolved deterministically by team and billing context.',
                    url: 'https://linear.app/kodus/issue/KC-1441',
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'LINEAR_GET_LINEAR_ISSUE' }],
            getToolsForLLM: () => [
                {
                    name: 'LINEAR_GET_LINEAR_ISSUE',
                    parameters: {
                        required: ['id'],
                        properties: {
                            id: {
                                type: 'string',
                                description: 'Issue id or key',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => [
                'LINEAR_GET_LINEAR_ISSUE',
            ]),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('linear'),
            createBaseParams(),
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Kody rules por time',
            description:
                'Rules must be resolved deterministically by team and billing context.',
            links: ['https://linear.app/kodus/issue/KC-1441'],
            sourceProvider: 'linear',
        });
    });

    it('extracts task context from a ClickUp task-style payload', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                task: {
                    id: '86d123',
                    name: 'Kody rules por time',
                    description:
                        'Adicionar escopo por time nas regras e no billing para evitar comportamento imprevisivel.',
                    url: 'https://app.clickup.com/t/86d123',
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'CLICKUP_GET_TASK' }],
            getToolsForLLM: () => [
                {
                    name: 'CLICKUP_GET_TASK',
                    parameters: {
                        required: ['taskId'],
                        properties: {
                            taskId: { type: 'string', description: 'Task ID' },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['CLICKUP_GET_TASK']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('clickup'),
            {
                ...createBaseParams(),
                userQuestion: '@kody 86d123',
            },
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: '86d123',
            title: 'Kody rules por time',
            description:
                'Adicionar escopo por time nas regras e no billing para evitar comportamento imprevisivel.',
            links: ['https://app.clickup.com/t/86d123'],
            sourceProvider: 'clickup',
        });
    });

    it('builds deterministic args for KODUS_GET_GITHUB_ISSUE using repository owner/name and issue number', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            success: true,
            data: {
                number: 37,
                title: 'Business logic validation issue',
                body: 'Issue context from GitHub',
                html_url: 'https://github.com/kodustech/kodus-ai/issues/37',
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'KODUS_GET_GITHUB_ISSUE' }],
            getToolsForLLM: () => [
                {
                    name: 'KODUS_GET_GITHUB_ISSUE',
                    parameters: {
                        required: [
                            'organizationId',
                            'teamId',
                            'repository',
                            'issueNumber',
                        ],
                        properties: {
                            organizationId: { type: 'string' },
                            teamId: { type: 'string' },
                            repository: {
                                type: 'object',
                                properties: {
                                    owner: { type: 'string' },
                                    name: { type: 'string' },
                                },
                                required: ['owner', 'name'],
                            },
                            issueNumber: { type: 'number' },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => [
                'KODUS_GET_GITHUB_ISSUE',
            ]),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('kodus-github-issues'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic use issue #37',
                repositoryOwner: 'kodustech',
                repositoryName: 'kodus-ai',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith('KODUS_GET_GITHUB_ISSUE', {
            organizationId: 'org-1',
            teamId: 'team-1',
            repository: {
                owner: 'kodustech',
                name: 'kodus-ai',
            },
            issueNumber: 37,
        });
    });

    it('includes repository and issue number hints in agent fallback prompt', async () => {
        const callAgent: CallAgentMock = jest.fn().mockResolvedValue({
            result: JSON.stringify({
                taskContext: 'Agent context',
                title: 'Agent title',
                id: 'GH-37',
                toolsUsed: ['KODUS_GET_GITHUB_ISSUE'],
            }),
        });

        const toolCaller: ToolCaller = {
            callTool: jest.fn(),
            callAgent,
            getRegisteredTools: () => [{ name: 'KODUS_GET_GITHUB_ISSUE' }],
            getToolsForLLM: () => [],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => []),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('kodus-github-issues'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic for issue #37',
                repositoryOwner: 'kodustech',
                repositoryName: 'kodus-ai',
                taskContextResolutionMode: 'agent_first',
            },
            hooks,
        );

        expect(callAgent).toHaveBeenCalled();
        const prompt = callAgent.mock.calls[0][1];
        expect(prompt).toContain('KNOWN_ISSUE_NUMBERS: 37');
        expect(prompt).toContain('KNOWN_REPOSITORY_OWNER: kodustech');
        expect(prompt).toContain('KNOWN_REPOSITORY_NAME: kodus-ai');
    });

    it('uses typed candidates for optional-only tool parameters', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            success: true,
            data: {
                number: 37,
                title: 'Optional params issue',
                body: 'Fetched with optional-only schema params',
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'KODUS_GET_GITHUB_ISSUE' }],
            getToolsForLLM: () => [
                {
                    name: 'KODUS_GET_GITHUB_ISSUE',
                    parameters: {
                        required: [],
                        properties: {
                            issueNumber: { type: 'number' },
                            repositoryOwner: { type: 'string' },
                            repositoryName: { type: 'string' },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => [
                'KODUS_GET_GITHUB_ISSUE',
            ]),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('kodus-github-issues'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic use issue #37',
                repositoryOwner: 'kodustech',
                repositoryName: 'kodus-ai',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'KODUS_GET_GITHUB_ISSUE',
            expect.objectContaining({
                issueNumber: 37,
                repositoryOwner: 'kodustech',
                repositoryName: 'kodus-ai',
            }),
        );
    });

    it('does not crash when provider payload contains empty objects in text fields', async () => {
        const callTool = jest.fn<ToolCaller['callTool']>().mockResolvedValue({
            result: {
                data: {
                    key: 'TASK-2',
                    fields: {
                        summary: 'Task title',
                        description: {},
                    },
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'searchTasks' }],
            getToolsForLLM: () => [
                {
                    name: 'searchTasks',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['searchTasks']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('linear'),
            createBaseParams(),
            hooks,
        );

        expect(result.normalized).toMatchObject({
            id: 'TASK-2',
            title: 'Task title',
            sourceProvider: 'linear',
        });
    });

    it('continues to the next deterministic tool when Jira issue details only contain smart-link metadata', async () => {
        const callTool: CallToolMock = jest
            .fn()
            .mockImplementation((toolName: string) => {
                if (toolName === 'getJiraIssue') {
                    return Promise.resolve({
                        result: {
                            data: {
                                key: 'KC-1441',
                                fields: {
                                    summary: 'Extension application link',
                                    description: {
                                        type: 'doc',
                                        version: 1,
                                        content: [
                                            {
                                                type: 'paragraph',
                                                content: [
                                                    {
                                                        type: 'inlineCard',
                                                        attrs: {
                                                            url: 'https://example.atlassian.net/wiki/spaces/EXT/pages/123',
                                                        },
                                                    },
                                                ],
                                            },
                                        ],
                                    },
                                },
                            },
                        },
                    });
                }

                if (toolName === 'search') {
                    return Promise.resolve({
                        result: {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify({
                                        id: 'KC-1441',
                                        title: 'Extension application link',
                                        description:
                                            'The extension must open the Atlassian app link in a webview and validate unsupported hosts.',
                                        acceptanceCriteria: [
                                            'Open supported Atlassian links inside the extension',
                                            'Reject unsupported hosts with a clear message',
                                        ],
                                    }),
                                },
                            ],
                        },
                    });
                }

                return Promise.resolve({ result: {} });
            });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [
                { name: 'getJiraIssue' },
                { name: 'search' },
            ],
            getToolsForLLM: () => [
                {
                    name: 'getJiraIssue',
                    parameters: {
                        required: ['cloudId', 'issueIdOrKey'],
                        properties: {
                            cloudId: {
                                type: 'string',
                                description: 'Cloud ID or site URL',
                            },
                            issueIdOrKey: {
                                type: 'string',
                                description: 'Issue ID or key',
                            },
                        },
                    },
                },
                {
                    name: 'search',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => [
                'getJiraIssue',
                'search',
            ]),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion:
                    '@kody -v business-logic https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                pullRequestDescription:
                    'Related to https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
            },
            hooks,
        );

        const calledTools = callTool.mock.calls.map(([toolName]) => toolName);
        expect(calledTools[0]).toBe('getJiraIssue');
        expect(calledTools).toContain('search');
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Extension application link',
            description:
                'The extension must open the Atlassian app link in a webview and validate unsupported hosts.',
            acceptanceCriteria: [
                'Open supported Atlassian links inside the extension',
                'Reject unsupported hosts with a clear message',
            ],
            sourceProvider: 'jira',
        });
    });

    it('uses the Jira site URL as cloudId candidate when issue link is available', async () => {
        const callTool: CallToolMock = jest
            .fn()
            .mockImplementation(
                (toolName: string, args: Record<string, unknown>) => {
                    if (toolName === 'getJiraIssue') {
                        return Promise.resolve({
                            result: {
                                data: {
                                    key: String(args.issueIdOrKey),
                                    fields: {
                                        summary: 'Jira task',
                                        description:
                                            'Resolved from Jira issue details',
                                    },
                                },
                            },
                        });
                    }

                    return Promise.resolve({ result: {} });
                },
            );

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'getJiraIssue' }],
            getToolsForLLM: () => [
                {
                    name: 'getJiraIssue',
                    parameters: {
                        required: ['cloudId', 'issueIdOrKey'],
                        properties: {
                            cloudId: {
                                type: 'string',
                                description: 'Cloud ID (UUID or site URL)',
                            },
                            issueIdOrKey: {
                                type: 'string',
                                description: 'Issue ID or key',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['getJiraIssue']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion:
                    '@kody https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                pullRequestDescription: '',
                prBody: '',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'getJiraIssue',
            expect.objectContaining({
                cloudId: 'https://kodustech.atlassian.net',
                issueIdOrKey: 'KC-1441',
            }),
        );
    });

    it('does not execute Jira fetch without an ARI identifier', async () => {
        const callTool: CallToolMock = jest.fn();
        const callAgent: CallAgentMock = jest.fn().mockResolvedValue({
            result: JSON.stringify({
                taskContext: 'Fallback context',
                id: 'KC-1441',
                title: 'Jira task',
                toolsUsed: ['search'],
            }),
        });

        const toolCaller: ToolCaller = {
            callTool,
            callAgent,
            getRegisteredTools: () => [{ name: 'fetch' }],
            getToolsForLLM: () => [
                {
                    name: 'fetch',
                    parameters: {
                        required: ['id'],
                        properties: {
                            id: {
                                type: 'string',
                                description:
                                    'Resource Identifier (ARI) from search results',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['fetch']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion: '@kody KC-1441',
            },
            hooks,
        );

        expect(callTool).not.toHaveBeenCalled();
        expect(callAgent).toHaveBeenCalled();
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Jira task',
            description: 'Fallback context',
            sourceProvider: 'jira',
        });
    });

    it('ignores non-task documentation URLs when selecting task links for Jira cloudId resolution', async () => {
        const callTool: CallToolMock = jest
            .fn()
            .mockImplementation(
                (toolName: string, args: Record<string, unknown>) => {
                    if (toolName === 'getJiraIssue') {
                        return Promise.resolve({
                            result: {
                                data: {
                                    key: String(args.issueIdOrKey),
                                    fields: {
                                        summary: 'Jira task',
                                        description:
                                            'Resolved from issue details',
                                    },
                                },
                            },
                        });
                    }

                    return Promise.resolve({ result: {} });
                },
            );

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'getJiraIssue' }],
            getToolsForLLM: () => [
                {
                    name: 'getJiraIssue',
                    parameters: {
                        required: ['cloudId', 'issueIdOrKey'],
                        properties: {
                            cloudId: {
                                type: 'string',
                                description: 'Cloud ID (UUID or site URL)',
                            },
                            issueIdOrKey: {
                                type: 'string',
                                description: 'Issue ID or key',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['getJiraIssue']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion:
                    '@kody KC-1441 https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441 https://editorconfig.org.',
                pullRequestDescription: '',
                prBody: '',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'getJiraIssue',
            expect.objectContaining({
                cloudId: 'https://kodustech.atlassian.net',
                issueIdOrKey: 'KC-1441',
            }),
        );
    });

    it('prioritizes explicit taskId over heuristic URLs for query-like tools', async () => {
        const callTool: CallToolMock = jest
            .fn()
            .mockImplementation(
                (_toolName: string, args: Record<string, unknown>) => {
                    const query = String(args.query ?? '');
                    if (query === 'KC-1441') {
                        return Promise.resolve({
                            result: {
                                task: {
                                    key: 'KC-1441',
                                    title: 'Jira task',
                                    description: 'Resolved from task key.',
                                },
                            },
                        });
                    }
                    return Promise.resolve({ result: {} });
                },
            );

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'search' }],
            getToolsForLLM: () => [
                {
                    name: 'search',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['search']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion:
                    '@kody https://kodustech.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-1441',
                pullRequestDescription: '',
                prBody: '',
                taskId: 'KC-1441',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'search',
            expect.objectContaining({ query: 'KC-1441' }),
        );
        expect(
            callTool.mock.calls.some(([, args]) =>
                String(args.query ?? '').includes('https://'),
            ),
        ).toBe(false);
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Jira task',
            description: 'Resolved from task key.',
            sourceProvider: 'jira',
        });
    });

    it('ignores deterministic tool payloads that are explicit fetch errors', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                error: true,
                message:
                    'Failed to fetch tenant info for cloud ID: http://editorconfig.org. Status: 404',
            },
        });
        const callAgent: CallAgentMock = jest.fn().mockResolvedValue({
            result: JSON.stringify({
                taskContext: 'Fallback task context from agent.',
                id: 'KC-1441',
                title: 'Jira task',
                toolsUsed: ['search'],
            }),
        });

        const toolCaller: ToolCaller = {
            callTool,
            callAgent,
            getRegisteredTools: () => [{ name: 'search' }],
            getToolsForLLM: () => [
                {
                    name: 'search',
                    parameters: {
                        required: ['query'],
                        properties: {
                            query: {
                                type: 'string',
                                description: 'Search query',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['search']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic KC-1441',
                pullRequestDescription: '',
                prBody: '',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalled();
        expect(callAgent).toHaveBeenCalled();
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Jira task',
            description: 'Fallback task context from agent.',
            sourceProvider: 'jira',
        });
    });

    it('uses explicit taskId parameter as deterministic issue hint even without issue key in prompt text', async () => {
        const callTool: CallToolMock = jest.fn().mockResolvedValue({
            result: {
                task: {
                    id: '86d123',
                    name: 'Kody rules por time',
                    description: 'Resolved from explicit taskId parameter.',
                },
            },
        });

        const toolCaller: ToolCaller = {
            callTool,
            getRegisteredTools: () => [{ name: 'CLICKUP_GET_TASK' }],
            getToolsForLLM: () => [
                {
                    name: 'CLICKUP_GET_TASK',
                    parameters: {
                        required: ['taskId'],
                        properties: {
                            taskId: { type: 'string', description: 'Task ID' },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['CLICKUP_GET_TASK']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('clickup'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic',
                pullRequestDescription: '',
                prBody: '',
                taskId: '86d123',
            },
            hooks,
        );

        expect(callTool).toHaveBeenCalledWith(
            'CLICKUP_GET_TASK',
            expect.objectContaining({ taskId: '86d123' }),
        );
        expect(result.normalized).toMatchObject({
            id: '86d123',
            title: 'Kody rules por time',
            description: 'Resolved from explicit taskId parameter.',
            sourceProvider: 'clickup',
        });
    });

    it('does not call Jira issue tool with invalid cloud context when only taskId is provided', async () => {
        const callTool: CallToolMock = jest.fn();
        const callAgent: CallAgentMock = jest.fn().mockResolvedValue({
            result: JSON.stringify({
                taskContext: 'Fallback context',
                id: 'KC-1441',
                title: 'Jira task',
                toolsUsed: ['search'],
            }),
        });

        const toolCaller: ToolCaller = {
            callTool,
            callAgent,
            getRegisteredTools: () => [{ name: 'getJiraIssue' }],
            getToolsForLLM: () => [
                {
                    name: 'getJiraIssue',
                    parameters: {
                        required: ['cloudId', 'issueIdOrKey'],
                        properties: {
                            cloudId: {
                                type: 'string',
                                description: 'Cloud ID (UUID or site URL)',
                            },
                            issueIdOrKey: {
                                type: 'string',
                                description: 'Issue ID or key',
                            },
                        },
                    },
                },
            ],
        };

        const hooks = {
            getSeedTaskContextTools: jest.fn(async () => ['getJiraIssue']),
            getCachedTaskContextTools: jest.fn(async () => []),
            saveCachedTaskContextTools: jest.fn(async () => undefined),
            resolvePreferredTool: jest.fn(async () => undefined),
            recordExecution: jest.fn(async () => undefined),
        };

        const result = await fetchTaskContext(
            toolCaller,
            createCapabilityRuntime('jira'),
            {
                ...createBaseParams(),
                userQuestion: '@kody -v business-logic',
                pullRequestDescription: '',
                prBody: '',
                taskId: 'KC-1441',
            },
            hooks,
        );

        expect(callTool).not.toHaveBeenCalled();
        expect(callAgent).toHaveBeenCalled();
        expect(result.normalized).toMatchObject({
            id: 'KC-1441',
            title: 'Jira task',
            description: 'Fallback context',
            sourceProvider: 'jira',
        });
    });
});
