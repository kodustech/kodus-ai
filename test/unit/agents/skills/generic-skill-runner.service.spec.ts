import { createMCPAdapter } from '@libs/mcp-server/mcp-adapter';

import { GenericSkillRunnerService } from '@libs/agents/skills/generic-skill-runner.service';
import {
    buildMcpAgentToolRegistry,
    runMcpFetcherAgent,
} from '@libs/agents/skills/runtime/ai-sdk-fetcher.adapter';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';
import {
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
} from '@libs/agents/skills/skill.errors';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

// MCP stays on the flow adapter; the agent loop runs on the harness via the
// ai-sdk-fetcher adapter — both are mocked here so the unit tests exercise the
// engine's orchestration logic (skill meta, preflight, filtering, policies,
// metrics) without a real MCP server or LLM call.
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
}));
jest.mock('@libs/agents/skills/runtime/ai-sdk-fetcher.adapter', () => ({
    buildMcpAgentToolRegistry: jest.fn(),
    runMcpFetcherAgent: jest.fn(),
}));

describe('GenericSkillRunnerService', () => {
    const createMCPAdapterMock = createMCPAdapter as jest.Mock;
    const buildMcpAgentToolRegistryMock =
        buildMcpAgentToolRegistry as jest.Mock;
    const runMcpFetcherAgentMock = runMcpFetcherAgent as jest.Mock;

    /** A connected flow MCP adapter (connect/getTools/executeTool/disconnect). */
    const makeMcpAdapter = () => ({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        getTools: jest.fn().mockResolvedValue([]),
        executeTool: jest.fn().mockResolvedValue({}),
    });

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    } as any;
    const withSkillMeta = (meta: Record<string, unknown> = {}) => ({
        name: 'business-rules-validation',
        description: 'Business rules validation skill',
        ...meta,
    });

    let skillLoaderService: jest.Mocked<SkillLoaderService>;
    let observabilityService: jest.Mocked<ObservabilityService>;
    let mcpManagerService: jest.Mocked<MCPManagerService>;
    let service: GenericSkillRunnerService;

    beforeEach(() => {
        skillLoaderService = {
            loadSkillMetaFromFilesystem: jest.fn(),
            loadInstructions: jest.fn(),
        } as any;
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta(),
        );

        observabilityService = {
            getAgentObservabilityConfig: jest.fn().mockReturnValue({}),
            getStorageConfig: jest.fn().mockReturnValue({}),
            // Billing wrapper — just run the wrapped exec and return its result.
            runAiSdkLLMInSpan: jest.fn((p: any) => p.exec()),
        } as any;

        mcpManagerService = {
            getConnections: jest.fn().mockResolvedValue([
                {
                    provider: 'kodusmcp',
                    allowedTools: ['KODUS_GET_PULL_REQUEST'],
                },
            ]),
        } as any;

        createMCPAdapterMock.mockReturnValue(makeMcpAdapter());
        buildMcpAgentToolRegistryMock.mockResolvedValue({
            get: () => undefined,
            list: () => [],
        });
        runMcpFetcherAgentMock.mockResolvedValue({
            text: '{}',
            state: { usage: {} },
            usage: { totalTokens: 0 },
        });

        service = new GenericSkillRunnerService(
            skillLoaderService,
            observabilityService,
            mcpManagerService,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('caches skill metadata by skill name for fetcher orchestration', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            }),
        );

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );
        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(
            skillLoaderService.loadSkillMetaFromFilesystem,
        ).toHaveBeenCalledTimes(1);
    });

    it('fails fast when required MCP categories are declared and no external MCP is connected', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples: 'Jira, Linear',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Kodus MCP',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(RequiredMcpPreflightError);
    });

    it('fails fast when required MCP provider hints do not match connected external providers', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples: 'Linear',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Kodus MCP',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
            {
                provider: 'jira',
                allowedTools: ['getJiraIssue'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(RequiredMcpPreflightError);
    });

    it('accepts a custom MCP connection when its app name matches a required provider hint', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples: 'Jira, Linear',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Kodus MCP',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
            {
                provider: 'custom',
                name: 'Jira',
                allowedTools: ['getJiraIssue'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).resolves.toBeDefined();
    });

    it('accepts Atlassian Rovo when it is listed in required MCP examples', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples:
                            'Jira, Atlassian Rovo, Linear, Notion, ClickUp, Github Issues',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Kodus MCP',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
            {
                provider: 'kodusmcp',
                name: 'Atlassian Rovo',
                allowedTools: ['getJiraIssue'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).resolves.toBeDefined();
    });

    it('accepts the Kodus built-in "Git Issues" MCP for task-management (regression)', async () => {
        // Real-world NO_TASK_MCP: the connected MCP is Kodus\'s built-in task
        // tracker whose appName is "Git Issues" (→ `gitissues`). The example
        // "Github Issues" normalizes to `githubissues`, which does NOT match
        // `gitissues` (the "hub" breaks both === and includes). The fix adds
        // "Git Issues" to the examples so the hint matches the real connection.
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples:
                            'Jira, Atlassian Rovo, Linear, Notion, ClickUp, Github Issues, Git Issues',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Git Issues',
                allowedTools: ['KODUS_LIST_ISSUES', 'KODUS_GET_ISSUE'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).resolves.toBeDefined();
    });

    it('matches by canonical registry category regardless of display name (drift-proof, the correct fix)', async () => {
        // The connection name matches NO example hint, but the mcp-manager
        // stamped its registry category. Category matching is the single source
        // of truth — it must accept the connection even when the name drifts.
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples: 'Jira, Linear',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Some Renamed Tracker',
                category: 'task-management',
                allowedTools: ['KODUS_LIST_ISSUES'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).resolves.toBeDefined();
    });

    it('filters external MCP providers by required MCP hints while keeping kodusmcp', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples: 'Jira, Linear',
                    },
                ],
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                name: 'Kodus MCP',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
            {
                provider: 'jira',
                allowedTools: ['getJiraIssue'],
            },
            {
                provider: 'linear',
                allowedTools: ['getIssue'],
            },
            {
                provider: 'notion',
                allowedTools: ['queryDatabase'],
            },
        ] as any);

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(createMCPAdapterMock).toHaveBeenCalledWith(
            expect.objectContaining({
                servers: expect.arrayContaining([
                    expect.objectContaining({ provider: 'kodusmcp' }),
                    expect.objectContaining({ provider: 'jira' }),
                    expect.objectContaining({ provider: 'linear' }),
                ]),
            }),
        );

        const createdAdapterArg = createMCPAdapterMock.mock.calls[0][0];
        const providerList = createdAdapterArg.servers.map(
            (server: { provider?: string }) => server.provider,
        );
        expect(providerList).not.toContain('notion');
    });

    it('passes MCP transport type through to createMCPAdapter', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: true, toolMode: 'any' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                name: 'Jira',
                provider: 'jira',
                type: 'http',
                url: 'https://jira.example.com/mcp',
                allowedTools: ['getJiraIssue'],
            },
        ] as any);

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(createMCPAdapterMock).toHaveBeenCalledWith(
            expect.objectContaining({
                servers: expect.arrayContaining([
                    expect.objectContaining({
                        provider: 'jira',
                        type: 'http',
                    }),
                ]),
            }),
        );
    });

    it('throws typed MCP connection error when required MCP exists but all connections fail', async () => {
        const adapter = makeMcpAdapter();
        adapter.connect.mockRejectedValue(
            new Error('Failed to connect to any MCP server'),
        );
        createMCPAdapterMock.mockReturnValue(adapter);

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: [
                    {
                        category: 'task-management',
                        label: 'Task Management',
                        examples: 'Jira, Linear',
                    },
                ],
            }),
        );

        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'jira',
                allowedTools: ['JIRA_GET_ISSUE'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);
    });

    it('throws typed MCP connection error for optional MCP skills when MCP connection fails', async () => {
        const adapter = makeMcpAdapter();
        adapter.connect.mockRejectedValue(
            new Error('Failed to connect to any MCP server'),
        );
        createMCPAdapterMock.mockReturnValue(adapter);

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: undefined,
            }),
        );

        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
        ] as any);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);
        expect(buildMcpAgentToolRegistryMock).not.toHaveBeenCalled();
    });

    it('throws typed MCP connection error when no MCP tools are available', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                requiredMcps: undefined,
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([] as any);
        createMCPAdapterMock.mockReturnValue(null);

        await expect(
            service.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);
    });

    it('allows fallback without tools when fetcher-policy enables it and defers fetcher agent creation', async () => {
        createMCPAdapterMock.mockReturnValue(null);

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
                fetcherPolicy: {
                    allowWithoutTools: true,
                    toolMode: 'all',
                },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([] as any);

        const runtime = await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        // No MCP adapter → nothing connected, no tool registry built.
        expect(buildMcpAgentToolRegistryMock).not.toHaveBeenCalled();
        await runtime.toolCaller.callAgent?.(
            'kodus-business-rules-validation-fetcher',
            'hello',
        );
        expect(runMcpFetcherAgentMock).toHaveBeenCalledTimes(1);
    });

    it('returns providerType derived from external MCP connections in runtime config', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: true, toolMode: 'any' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
            {
                provider: 'jira',
                allowedTools: ['getJiraIssue'],
            },
        ] as any);

        const runtime = await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(runtime.capabilityRuntime.providerType).toBe('jira');
    });

    it('derives runtime providerType from custom MCP app name when provider is generic', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: true, toolMode: 'any' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST'],
            },
            {
                provider: 'custom',
                name: 'Jira',
                allowedTools: [
                    'getAccessibleAtlassianResources',
                    'getJiraIssue',
                ],
            },
        ] as any);

        const runtime = await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(runtime.capabilityRuntime.providerType).toBe('jira');
        expect(runtime.capabilityRuntime.allProviderTypes).toContain('jira');
    });

    it('resolves required tools from declared capabilities', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                capabilities: ['pr.diff.read'],
                fetcherPolicy: {
                    toolMode: 'all',
                    allowWithoutTools: false,
                },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
            },
        ] as any);

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(createMCPAdapterMock).toHaveBeenCalledWith(
            expect.objectContaining({
                servers: expect.arrayContaining([
                    expect.objectContaining({
                        provider: 'kodusmcp',
                        allowedTools: ['KODUS_GET_PULL_REQUEST_DIFF'],
                    }),
                ]),
            }),
        );
    });

    it('resolves required tools from capabilityDefinitions', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                capabilities: ['custom.capability.read'],
                capabilityDefinitions: {
                    'custom.capability.read': {
                        mode: 'fixed_tools',
                        tools: ['getCustomCapability'],
                    },
                },
                fetcherPolicy: {
                    toolMode: 'all',
                    allowWithoutTools: false,
                },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            {
                provider: 'kodusmcp',
                allowedTools: ['getCustomCapability'],
            },
        ] as any);

        await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(createMCPAdapterMock).toHaveBeenCalledWith(
            expect.objectContaining({
                servers: expect.arrayContaining([
                    expect.objectContaining({
                        provider: 'kodusmcp',
                        allowedTools: ['getCustomCapability'],
                    }),
                ]),
            }),
        );
    });

    it('records setup metrics with stage/status labels on fetcher success', async () => {
        const metricsCollector = {
            recordHistogram: jest.fn(),
            recordCounter: jest.fn(),
            recordGauge: jest.fn(),
        } as unknown as jest.Mocked<MetricsCollectorService>;

        const serviceWithMetrics = new GenericSkillRunnerService(
            skillLoaderService,
            observabilityService,
            mcpManagerService,
            metricsCollector,
        );

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: true, toolMode: 'all' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([] as any);
        createMCPAdapterMock.mockReturnValue(null);

        await serviceWithMetrics.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(metricsCollector.recordHistogram).toHaveBeenCalledWith(
            'kodus_skill_setup_duration_ms',
            expect.any(Number),
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'success',
            }),
        );
        expect(metricsCollector.recordCounter).toHaveBeenCalledWith(
            'kodus_skill_setup_total',
            1,
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'success',
            }),
        );
    });

    it('getExecutionPolicy returns resolved defaults from SKILL.md metadata', () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                executionPolicy: {
                    onMissingMcp: 'fallback',
                    analyzerTimeoutMs: 60000,
                    analyzerMaxIterations: 3,
                },
                fetcherPolicy: {
                    allowWithoutTools: true,
                    toolMode: 'any',
                },
            }),
        );

        const policy = service.getExecutionPolicy('business-rules-validation');

        expect(policy.onMissingMcp).toBe('fallback');
        expect(policy.onMcpConnectError).toBe('fallback');
        expect(policy.analyzerTimeoutMs).toBe(60000);
        expect(policy.analyzerMaxIterations).toBe(3);
        expect(policy.fetcherTimeoutMs).toBe(120_000);
        expect(policy.fetcherMaxIterations).toBe(4);
    });

    it('getExecutionPolicy uses fail defaults when allowWithoutTools is false', () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: {
                    allowWithoutTools: false,
                    toolMode: 'all',
                },
            }),
        );

        const policy = service.getExecutionPolicy('business-rules-validation');

        expect(policy.onMissingMcp).toBe('fail');
        expect(policy.onMcpConnectError).toBe('fail');
    });

    it('resolveAllProviderTypes returns deduplicated providers excluding kodusmcp', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: true, toolMode: 'any' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            { provider: 'kodusmcp', allowedTools: ['KODUS_GET_PULL_REQUEST'] },
            { provider: 'Jira', allowedTools: ['getJiraIssue'] },
            { provider: 'atlassian', allowedTools: ['searchJira'] },
            { provider: 'linear', allowedTools: ['getIssue'] },
            { provider: 'Jira', allowedTools: ['otherJiraTool'] },
        ] as any);

        const runtime = await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(runtime.capabilityRuntime.providerType).toBe('jira');
        expect(runtime.capabilityRuntime.allProviderTypes).toEqual([
            'jira',
            'atlassian',
            'linear',
        ]);
    });

    it('resolveAllProviderTypes keeps provider identity without hardcoded aliases', async () => {
        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: true, toolMode: 'any' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([
            { provider: 'kodusmcp', allowedTools: ['KODUS_GET_PULL_REQUEST'] },
            { provider: 'atlassian', allowedTools: ['searchJira'] },
        ] as any);

        const runtime = await service.createFetcherOrchestration(
            'business-rules-validation',
            {} as any,
            organizationAndTeamData,
        );

        expect(runtime.capabilityRuntime.providerType).toBe('atlassian');
        expect(runtime.capabilityRuntime.allProviderTypes).toEqual([
            'atlassian',
        ]);
    });

    it('records setup failure metrics when fetcher initialization fails', async () => {
        const metricsCollector = {
            recordHistogram: jest.fn(),
            recordCounter: jest.fn(),
            recordGauge: jest.fn(),
        } as unknown as jest.Mocked<MetricsCollectorService>;

        const serviceWithMetrics = new GenericSkillRunnerService(
            skillLoaderService,
            observabilityService,
            mcpManagerService,
            metricsCollector,
        );

        skillLoaderService.loadSkillMetaFromFilesystem.mockReturnValue(
            withSkillMeta({
                fetcherPolicy: { allowWithoutTools: false, toolMode: 'all' },
            }),
        );
        mcpManagerService.getConnections.mockResolvedValue([] as any);
        createMCPAdapterMock.mockReturnValue(null);

        await expect(
            serviceWithMetrics.createFetcherOrchestration(
                'business-rules-validation',
                {} as any,
                organizationAndTeamData,
            ),
        ).rejects.toBeInstanceOf(McpConnectionUnavailableError);

        expect(metricsCollector.recordHistogram).toHaveBeenCalledWith(
            'kodus_skill_setup_duration_ms',
            expect.any(Number),
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'failed',
            }),
        );
        expect(metricsCollector.recordCounter).toHaveBeenCalledWith(
            'kodus_skill_setup_total',
            1,
            expect.objectContaining({
                skill: 'business-rules-validation',
                stage: 'fetcher',
                status: 'failed',
            }),
        );
    });
});
