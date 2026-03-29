import { createMCPAdapter, createOrchestration } from '@kodus/flow';

import { GenericSkillRunnerService } from '@libs/agents/skills/generic-skill-runner.service';
import { SkillLoaderService } from '@libs/agents/skills/skill-loader.service';
import {
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
} from '@libs/agents/skills/skill.errors';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

jest.mock('@kodus/flow', () => ({
    createMCPAdapter: jest.fn(),
    createOrchestration: jest.fn(),
    PlannerType: { REACT: 'REACT' },
}));

describe('GenericSkillRunnerService', () => {
    const createOrchestrationMock = createOrchestration as jest.Mock;
    const createMCPAdapterMock = createMCPAdapter as jest.Mock;

    const makeOrchestrator = () => ({
        connectMCP: jest.fn().mockResolvedValue(undefined),
        registerMCPTools: jest.fn().mockResolvedValue(undefined),
        createAgent: jest.fn().mockResolvedValue(undefined),
        callTool: jest.fn().mockResolvedValue({ result: {} }),
        callAgent: jest.fn().mockResolvedValue({ result: {} }),
        getRegisteredTools: jest.fn().mockReturnValue([]),
        getToolsForLLM: jest.fn().mockReturnValue([]),
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
        } as any;

        mcpManagerService = {
            getConnections: jest.fn().mockResolvedValue([
                {
                    provider: 'kodusmcp',
                    allowedTools: ['KODUS_GET_PULL_REQUEST'],
                },
            ]),
        } as any;

        createOrchestrationMock.mockResolvedValue(makeOrchestrator());
        createMCPAdapterMock.mockReturnValue({} as any);

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

    it('caches analyzer instructions by skill name', async () => {
        skillLoaderService.loadInstructions.mockReturnValue(
            'analyzer instructions',
        );

        await service.createAnalyzerOrchestration(
            'business-rules-validation',
            {} as any,
        );
        await service.createAnalyzerOrchestration(
            'business-rules-validation',
            {} as any,
        );

        expect(skillLoaderService.loadInstructions).toHaveBeenCalledTimes(1);
    });

    it('separates analyzer instruction cache by team context', async () => {
        skillLoaderService.loadInstructions.mockReturnValue(
            'analyzer instructions',
        );

        await service.createAnalyzerOrchestration(
            'business-rules-validation',
            {} as any,
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                } as any,
            },
        );
        await service.createAnalyzerOrchestration(
            'business-rules-validation',
            {} as any,
            {
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-2',
                } as any,
            },
        );

        expect(skillLoaderService.loadInstructions).toHaveBeenCalledTimes(2);
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
        const orchestrator = makeOrchestrator();
        orchestrator.connectMCP.mockRejectedValue(
            new Error('Failed to connect to any MCP server'),
        );
        createOrchestrationMock.mockResolvedValue(orchestrator);

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
        const orchestrator = makeOrchestrator();
        orchestrator.connectMCP.mockRejectedValue(
            new Error('Failed to connect to any MCP server'),
        );
        createOrchestrationMock.mockResolvedValue(orchestrator);

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
        expect(orchestrator.registerMCPTools).not.toHaveBeenCalled();
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
        const orchestrator = makeOrchestrator();
        createOrchestrationMock.mockResolvedValue(orchestrator);
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

        expect(orchestrator.connectMCP).not.toHaveBeenCalled();
        expect(orchestrator.registerMCPTools).not.toHaveBeenCalled();
        expect(orchestrator.createAgent).not.toHaveBeenCalled();
        await runtime.toolCaller.callAgent?.(
            'kodus-business-rules-validation-fetcher',
            'hello',
        );
        expect(orchestrator.createAgent).toHaveBeenCalledTimes(1);
        expect(orchestrator.callAgent).toHaveBeenCalledTimes(1);
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
