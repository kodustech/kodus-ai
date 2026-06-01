import {
    createMCPAdapter,
    createOrchestration,
    LLMAdapter,
    MCPAdapter,
    MCPServerConfig,
    PlannerType,
    Thread,
} from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import { BoundedMap } from './runtime/bounded-map';
import {
    AgentCallOptions,
    SkillCapabilityRuntimeConfig,
    SkillFetcherRuntime,
    ToolCaller,
    ToolExecutionResponse,
} from './runtime/skill-runtime.types';
import { resolveCapabilityTools } from './skill-capabilities';
import {
    SkillExecutionPolicy,
    SkillFetcherPolicy,
    SkillInstructionsLoadOptions,
    SkillLoaderService,
    SkillMeta,
    SkillRequiredMcp,
} from './skill-loader.service';
import {
    McpConnectionUnavailableError,
    RequiredMcpPreflightError,
} from './skill.errors';

export interface SkillFetcherResult {
    raw: string;
    parsed: Record<string, unknown>;
}

export interface SkillRunInput {
    organizationAndTeamData: OrganizationAndTeamData;
    thread?: Thread;
    fetcherPrompt: string;
    analyzerPrompt: string;
}

export type { SkillCapabilityRuntimeConfig } from './runtime/skill-runtime.types';

type ResolvedExecutionPolicy = Required<
    Pick<
        SkillExecutionPolicy,
        | 'onMissingMcp'
        | 'onMcpConnectError'
        | 'fetcherTimeoutMs'
        | 'analyzerTimeoutMs'
        | 'fetcherMaxIterations'
        | 'analyzerMaxIterations'
    >
>;

export type SkillResolvedExecutionPolicy = ResolvedExecutionPolicy;

interface McpConnectionMetadata {
    connection?: {
        id?: string;
        serverName?: string;
        appName?: string;
    };
}

type McpConnection = MCPServerConfig & {
    metadata?: McpConnectionMetadata;
};

/**
 * Shared infrastructure for the fetcher+analyzer pattern used by all PR-level skills.
 *
 * Each skill agent is responsible for:
 *  - Building the fetcher and analyzer prompts
 *  - Parsing and interpreting the raw result
 *
 * GenericSkillRunnerService handles:
 *  - MCP adapter creation (from SKILL.md allowed-tools)
 *  - Fetcher orchestration (with MCP tools; fetcher agent initialized lazily on demand)
 *  - Analyzer orchestration (instructions from SKILL.md, no tools, maxIterations: 1)
 */
@Injectable()
export class GenericSkillRunnerService {
    private readonly logger = new Logger(GenericSkillRunnerService.name);
    private readonly instructionsCache = new BoundedMap<string, string>(128);
    private readonly metaCache = new BoundedMap<string, SkillMeta>(64);

    constructor(
        private readonly skillLoaderService: SkillLoaderService,
        private readonly observabilityService: ObservabilityService,
        private readonly mcpManagerService?: MCPManagerService,
        @Optional() private readonly metricsCollector?: MetricsCollectorService,
    ) {}

    /**
     * Creates a ready-to-use fetcher orchestration for a skill.
     * Connects MCP tools based on SKILL.md allowed-tools frontmatter.
     */
    async createFetcherOrchestration(
        skillName: string,
        llmAdapter: LLMAdapter,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<SkillFetcherRuntime> {
        const startedAt = Date.now();
        try {
            const meta = this.getSkillMeta(skillName);
            this.validateSkillSchema(meta, skillName);
            const fetcherPolicy = this.resolveFetcherPolicy(meta.fetcherPolicy);
            const executionPolicy = this.resolveExecutionPolicy(
                meta.executionPolicy,
                fetcherPolicy,
            );
            const requiredTools = this.resolveRequiredTools(meta, skillName);
            if (!this.mcpManagerService) {
                this.logger.warn(
                    `[GenericSkillRunner] MCPManagerService is unavailable for skill '${skillName}'.`,
                );
            }
            const mcpManagerServers = this.mcpManagerService
                ? await this.mcpManagerService.getConnections(
                      organizationAndTeamData,
                  )
                : [];
            const availableProviders =
                this.getAvailableProviders(mcpManagerServers);
            const allProviderTypes =
                this.resolveAllProviderTypes(mcpManagerServers);
            const providerType =
                allProviderTypes.length > 0 ? allProviderTypes[0] : 'external';
            const requiredProviderHints = this.resolveRequiredProviderHints(
                meta.requiredMcps,
            );

            this.preflightRequiredMcps(
                skillName,
                meta.requiredMcps,
                requiredProviderHints,
                availableProviders,
                mcpManagerServers,
            );

            const mcpAdapter = this.createMCPAdapter(
                skillName,
                requiredTools,
                fetcherPolicy,
                requiredProviderHints,
                mcpManagerServers,
            );
            this.metricsCollector?.recordGauge(
                'kodus_skill_required_tools_total',
                requiredTools.length,
                { skill: skillName },
            );

            if (!mcpAdapter) {
                if (executionPolicy.onMissingMcp === 'fallback') {
                    this.logger.warn(
                        `[GenericSkillRunner] No MCP tools available for skill '${skillName}', but policy allows fallback without tools.`,
                    );
                    this.metricsCollector?.recordCounter(
                        'kodus_skill_mcp_fallback_total',
                        1,
                        { skill: skillName, reason: 'missing_mcp_or_tools' },
                    );
                } else {
                    this.metricsCollector?.recordCounter(
                        'kodus_skill_mcp_failfast_total',
                        1,
                        { skill: skillName, reason: 'missing_mcp_or_tools' },
                    );
                    throw new McpConnectionUnavailableError({
                        skillName,
                        availableProviders,
                        causeMessage:
                            'No MCP tools available for this skill with current connections.',
                    });
                }
            }

            const orchestration = await createOrchestration({
                tenantId: `kodus-skill-fetcher-${skillName}`,
                llmAdapter,
                mcpAdapter,
                observability:
                    this.observabilityService.getAgentObservabilityConfig(
                        `kodus-${skillName}-fetcher`,
                    ),
                storage: this.observabilityService.getStorageConfig(),
            });

            if (mcpAdapter) {
                try {
                    await orchestration.connectMCP();
                    await orchestration.registerMCPTools();

                    const registeredTools = orchestration.getRegisteredTools();
                    this.logger.log({
                        message: `[GenericSkillRunner] MCP tools registered for skill '${skillName}'`,
                        context: 'createFetcherOrchestration',
                        metadata: {
                            skillName,
                            registeredToolCount: registeredTools.length,
                            registeredToolNames: registeredTools.map(
                                (t: { name?: string }) => t.name,
                            ),
                        },
                    });
                } catch (error) {
                    if (executionPolicy.onMcpConnectError === 'fallback') {
                        this.logger.warn(
                            `[GenericSkillRunner] MCP connection failed for skill '${skillName}', but policy allows fallback without tools. Error: ${
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                            }`,
                        );
                        this.metricsCollector?.recordCounter(
                            'kodus_skill_mcp_fallback_total',
                            1,
                            { skill: skillName, reason: 'connect_error' },
                        );
                    } else {
                        this.metricsCollector?.recordCounter(
                            'kodus_skill_mcp_failfast_total',
                            1,
                            { skill: skillName, reason: 'connect_error' },
                        );
                        throw new McpConnectionUnavailableError({
                            skillName,
                            availableProviders,
                            causeMessage:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        });
                    }
                }
            }

            let fetcherAgentInitialized = false;
            const ensureFetcherAgent = async (): Promise<void> => {
                if (fetcherAgentInitialized) {
                    return;
                }
                await orchestration.createAgent({
                    name: `kodus-${skillName}-fetcher`,
                    identity: {
                        goal: `Fetch all relevant context for the ${skillName} skill using available tools. Return structured JSON with the gathered data.`,
                        description: `Context fetcher for ${skillName}.`,
                        language: 'en-US',
                    },
                    maxIterations: executionPolicy.fetcherMaxIterations,
                    timeout: executionPolicy.fetcherTimeoutMs,
                    plannerOptions: { type: PlannerType.REACT },
                });
                fetcherAgentInitialized = true;
            };

            const toolCaller: ToolCaller = {
                callTool: async (toolName, args) =>
                    this.normalizeToolExecutionResponse(
                        await orchestration.callTool(toolName, args),
                    ),
                callAgent: async (agentName, prompt, options) => {
                    await ensureFetcherAgent();
                    return this.normalizeToolExecutionResponse(
                        await orchestration.callAgent(
                            agentName,
                            prompt,
                            options as AgentCallOptions,
                        ),
                    );
                },
                getRegisteredTools: () => orchestration.getRegisteredTools(),
                getToolsForLLM: () => {
                    const getter = (
                        orchestration as unknown as {
                            getToolsForLLM?: () => Array<{
                                name?: string;
                                parameters?: unknown;
                            }>;
                        }
                    ).getToolsForLLM;
                    return typeof getter === 'function'
                        ? getter.call(orchestration)
                        : [];
                },
            };

            const capabilityRuntime = this.getCapabilityRuntimeConfig(
                skillName,
                {
                    providerType,
                    allProviderTypes,
                },
            );
            this.recordSetupMetric(skillName, 'fetcher', 'success', startedAt);
            return {
                toolCaller,
                capabilityRuntime,
            };
        } catch (error) {
            this.recordSetupMetric(skillName, 'fetcher', 'failed', startedAt);
            throw error;
        }
    }

    /**
     * Creates a ready-to-use analyzer orchestration for a skill.
     * Loads instructions from SKILL.md (body + references).
     *
     * @deprecated Use `getExecutionPolicy()` + direct LLM adapter calls instead.
     * The production path (BusinessRulesValidationAgentProvider.runAnalyzer) no longer
     * calls this method — it uses getExecutionPolicy() with withTimeout and retry.
     * Kept for backward compatibility with existing tests.
     */
    async createAnalyzerOrchestration(
        skillName: string,
        llmAdapter: LLMAdapter,
        options?: {
            organizationAndTeamData?: OrganizationAndTeamData;
            customInstructions?: string;
        },
    ): Promise<SDKOrchestrator> {
        const startedAt = Date.now();
        try {
            const meta = this.getSkillMeta(skillName);
            this.validateSkillSchema(meta, skillName);
            const fetcherPolicy = this.resolveFetcherPolicy(meta.fetcherPolicy);
            const executionPolicy = this.resolveExecutionPolicy(
                meta.executionPolicy,
                fetcherPolicy,
            );
            const instructions = this.getSkillInstructions(skillName, {
                organizationId:
                    options?.organizationAndTeamData?.organizationId,
                teamId: options?.organizationAndTeamData?.teamId,
                customInstructions: options?.customInstructions,
            });

            const orchestration = await createOrchestration({
                tenantId: `kodus-skill-analyzer-${skillName}`,
                llmAdapter,
                observability:
                    this.observabilityService.getAgentObservabilityConfig(
                        `kodus-${skillName}-analyzer`,
                    ),
                storage: this.observabilityService.getStorageConfig(),
            });

            await orchestration.createAgent({
                name: `kodus-${skillName}-analyzer`,
                identity: {
                    goal: instructions,
                    description: `${skillName} analyzer. No tool access. Receives structured context. Returns analysis.`,
                    language: 'en-US',
                },
                maxIterations: executionPolicy.analyzerMaxIterations,
                timeout: executionPolicy.analyzerTimeoutMs,
                plannerOptions: { type: PlannerType.REACT },
            });

            this.recordSetupMetric(skillName, 'analyzer', 'success', startedAt);
            return orchestration;
        } catch (error) {
            this.recordSetupMetric(skillName, 'analyzer', 'failed', startedAt);
            throw error;
        }
    }

    getCapabilityRuntimeConfig(
        skillName: string,
        options?: {
            providerType?: string;
            allProviderTypes?: string[];
        },
    ): SkillCapabilityRuntimeConfig {
        const meta = this.getSkillMeta(skillName);
        return {
            capabilities: meta.capabilities ?? [],
            allowedTools: meta.allowedTools ?? [],
            capabilityToolMap: meta.capabilityToolMap,
            capabilityDefinitions: meta.capabilityDefinitions,
            fetcherPolicy: this.resolveFetcherPolicy(meta.fetcherPolicy),
            providerType: options?.providerType ?? 'external',
            allProviderTypes: options?.allProviderTypes,
            contracts: meta.contracts,
        };
    }

    getAnalyzerInstructions(
        skillName: string,
        options?: SkillInstructionsLoadOptions,
    ): string {
        const baseInstructions = this.getSkillInstructions(skillName, options);
        const references = this.skillLoaderService.listReferences(skillName);
        if (!references.length) {
            return baseInstructions;
        }

        const referenceContent = references
            .map((fileName) =>
                this.skillLoaderService.loadReference(skillName, fileName),
            )
            .filter(
                (content): content is string =>
                    typeof content === 'string' && content.trim().length > 0,
            )
            .map((content) => content.trim())
            .join('\n\n---\n\n');

        if (!referenceContent.length) {
            return baseInstructions;
        }

        return `${baseInstructions}\n\n---\n\n## Reference Material\n\n${referenceContent}`;
    }

    getExecutionPolicy(skillName: string): SkillResolvedExecutionPolicy {
        const meta = this.getSkillMeta(skillName);
        const fetcherPolicy = this.resolveFetcherPolicy(meta.fetcherPolicy);
        return this.resolveExecutionPolicy(meta.executionPolicy, fetcherPolicy);
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private getSkillMeta(skillName: string): SkillMeta {
        const cached = this.metaCache.get(skillName);
        if (cached) {
            return cached;
        }

        const meta =
            this.skillLoaderService.loadSkillMetaFromFilesystem(skillName) ??
            {};
        this.metaCache.set(skillName, meta);
        return meta;
    }

    private getSkillInstructions(
        skillName: string,
        options?: SkillInstructionsLoadOptions,
    ): string {
        const cacheKey = this.buildInstructionsCacheKey(skillName, options);
        const cached = this.instructionsCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const instructions = this.skillLoaderService.loadInstructions(
            skillName,
            options,
        );
        this.instructionsCache.set(cacheKey, instructions);
        return instructions;
    }

    private buildInstructionsCacheKey(
        skillName: string,
        options?: SkillInstructionsLoadOptions,
    ): string {
        const organizationId = options?.organizationId?.trim() || '-';
        const teamId = options?.teamId?.trim() || '-';
        const customInstructions = options?.customInstructions?.trim();
        const customInstructionsKey = customInstructions
            ? `custom:${this.hashCacheSegment(customInstructions)}`
            : 'custom:-';

        return `${skillName}|org:${organizationId}|team:${teamId}|${customInstructionsKey}`;
    }

    private hashCacheSegment(value: string): string {
        let hash = 0;
        for (let i = 0; i < value.length; i += 1) {
            hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
        }
        return `${value.length}-${hash.toString(16)}`;
    }

    private preflightRequiredMcps(
        skillName: string,
        requiredMcps: SkillRequiredMcp[] | undefined,
        requiredProviderHints: string[],
        availableProviders: string[],
        mcpManagerServers: McpConnection[] | undefined,
    ): void {
        if (!requiredMcps?.length) {
            return;
        }

        const externalConnections = (mcpManagerServers ?? []).filter(
            (server) => {
                const serverProvider = String(server?.provider ?? '')
                    .trim()
                    .toLowerCase();
                const serverName = String(server?.name ?? '')
                    .trim()
                    .toLowerCase();

                return !(
                    serverProvider === 'kodusmcp' && serverName === 'kodus mcp'
                );
            },
        );

        if (!externalConnections.length) {
            this.logger.warn(
                `[GenericSkillRunner] Missing required external MCP for skill '${skillName}'. Available providers: ${
                    availableProviders.length
                        ? availableProviders.join(', ')
                        : 'none'
                }`,
            );
            throw new RequiredMcpPreflightError(
                skillName,
                requiredMcps,
                availableProviders,
            );
        }
        if (!requiredProviderHints.length) {
            return;
        }

        const matchingExternalConnections = externalConnections.filter(
            (server) =>
                this.serverMatchesRequiredHints(server, requiredProviderHints),
        );

        if (!matchingExternalConnections.length) {
            this.logger.warn(
                `[GenericSkillRunner] No connected external MCP provider matches required hints for skill '${skillName}'. Required hints: ${requiredProviderHints.join(
                    ', ',
                )}. Available providers: ${
                    availableProviders.length
                        ? availableProviders.join(', ')
                        : 'none'
                }`,
            );
            throw new RequiredMcpPreflightError(
                skillName,
                requiredMcps,
                availableProviders,
            );
        }
    }

    private createMCPAdapter(
        skillName: string,
        requiredTools: string[] | undefined,
        fetcherPolicy: Required<SkillFetcherPolicy>,
        requiredProviderHints: string[],
        mcpManagerServers: McpConnection[] | undefined,
    ): MCPAdapter | null {
        if (!mcpManagerServers?.length) {
            this.logger.warn(
                `[GenericSkillRunner] No MCP servers available for skill '${skillName}'.`,
            );
            return null;
        }

        const resolvedRequiredTools = requiredTools?.length
            ? requiredTools
            : [];
        const hasRequiredTools = this.hasRequiredKodusTools(
            mcpManagerServers,
            resolvedRequiredTools,
            fetcherPolicy,
        );

        const filteredServers = mcpManagerServers
            .filter((server) => {
                const serverProvider = String(server?.provider ?? '')
                    .trim()
                    .toLowerCase();
                const serverName = String(server?.name ?? '')
                    .trim()
                    .toLowerCase();

                if (
                    serverProvider === 'kodusmcp' &&
                    serverName === 'kodus mcp'
                ) {
                    if (!resolvedRequiredTools.length) {
                        return true;
                    }
                    const availableTools = Array.isArray(server.allowedTools)
                        ? server.allowedTools
                        : [];
                    return resolvedRequiredTools.some((tool) =>
                        availableTools.includes(tool),
                    );
                }

                if (!requiredProviderHints.length) {
                    return true;
                }
                return this.serverMatchesRequiredHints(
                    server,
                    requiredProviderHints,
                );
            })
            .map((server) => {
                const serverProvider = String(server?.provider ?? '')
                    .trim()
                    .toLowerCase();
                const serverName = String(server?.name ?? '')
                    .trim()
                    .toLowerCase();

                if (
                    serverProvider === 'kodusmcp' &&
                    serverName === 'kodus mcp'
                ) {
                    if (!resolvedRequiredTools.length) {
                        return server;
                    }
                    return {
                        ...server,
                        allowedTools: Array.isArray(server.allowedTools)
                            ? server.allowedTools.filter((tool) =>
                                  resolvedRequiredTools.includes(tool),
                              )
                            : [],
                    };
                }
                return server;
            });

        if (!filteredServers.length) {
            this.logger.warn({
                message: `[GenericSkillRunner] No servers remaining after filtering for skill '${skillName}'`,
                context: 'createMCPAdapter',
                metadata: {
                    skillName,
                    totalServers: mcpManagerServers?.length,
                    resolvedRequiredTools,
                },
            });
            return null;
        }
        if (resolvedRequiredTools.length && !hasRequiredTools) {
            this.logger.warn(
                `[GenericSkillRunner] Required tools not available for skill '${skillName}'. toolMode=${fetcherPolicy.toolMode}, requiredTools=${resolvedRequiredTools.join(
                    ', ',
                )}`,
            );
            return null;
        }

        this.logger.log({
            message: `[GenericSkillRunner] MCP adapter created for skill '${skillName}'`,
            context: 'createMCPAdapter',
            metadata: {
                skillName,
                serverCount: filteredServers.length,
                servers: filteredServers.map((s) => ({
                    name: s.name,
                    provider: s.provider,
                    allowedToolCount: Array.isArray(s.allowedTools)
                        ? s.allowedTools.length
                        : 0,
                    allowedTools: Array.isArray(s.allowedTools)
                        ? s.allowedTools
                        : [],
                })),
                resolvedRequiredTools,
            },
        });

        return createMCPAdapter({
            servers: filteredServers,
            defaultTimeout: 15_000,
            maxRetries: 2,
            onError: (err) =>
                this.logger.error(
                    `[GenericSkillRunner] MCP error for skill '${skillName}': ${err.message}`,
                ),
        });
    }

    private resolveRequiredProviderHints(
        requiredMcps: SkillRequiredMcp[] | undefined,
    ): string[] {
        if (!requiredMcps?.length) {
            return [];
        }

        const hints = new Set<string>();
        for (const requiredMcp of requiredMcps) {
            const examples = requiredMcp.examples;
            if (!examples) {
                continue;
            }
            for (const token of examples.split(',')) {
                const normalized = this.normalizeProviderToken(token);
                if (normalized) {
                    hints.add(normalized);
                }
            }
        }

        return [...hints];
    }

    private providerMatchesRequiredHints(
        provider: unknown,
        requiredHints: string[],
    ): boolean {
        if (!requiredHints.length) {
            return true;
        }
        const normalizedProvider = this.normalizeProviderToken(provider);
        if (!normalizedProvider) {
            return false;
        }

        return requiredHints.some(
            (hint) =>
                normalizedProvider === hint ||
                normalizedProvider.includes(hint) ||
                hint.includes(normalizedProvider),
        );
    }

    private serverMatchesRequiredHints(
        server: McpConnection,
        requiredHints: string[],
    ): boolean {
        if (!requiredHints.length) {
            return true;
        }

        return this.getServerProviderAliases(server).some((alias) =>
            this.providerMatchesRequiredHints(alias, requiredHints),
        );
    }

    private getServerProviderAliases(server: McpConnection): string[] {
        const metadataConnection = server?.metadata?.connection;
        const aliases = [
            server?.provider,
            server?.name,
            metadataConnection?.id,
            metadataConnection?.serverName,
            metadataConnection?.appName,
        ];

        return [
            ...new Set(aliases.filter((alias) => typeof alias === 'string')),
        ];
    }

    private normalizeProviderToken(value: unknown): string {
        if (typeof value !== 'string') {
            return '';
        }
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private getAvailableProviders(
        mcpManagerServers: McpConnection[] | undefined,
    ): string[] {
        return (mcpManagerServers ?? []).map((server) =>
            typeof server?.provider === 'string'
                ? server.provider
                : 'unknown-provider',
        );
    }

    private resolveAllProviderTypes(
        mcpManagerServers: McpConnection[] | undefined,
    ): string[] {
        const seen = new Set<string>();
        const result: string[] = [];

        for (const server of mcpManagerServers ?? []) {
            for (const providerType of this.resolveServerProviderTypes(
                server,
            )) {
                if (!seen.has(providerType)) {
                    seen.add(providerType);
                    result.push(providerType);
                }
            }
        }

        return result;
    }

    private resolveServerProviderTypes(server: McpConnection): string[] {
        const aliases = this.getServerProviderAliases(server)
            .map((alias) => this.normalizeProviderToken(alias))
            .filter((alias) => alias.length > 0 && alias !== 'kodusmcp');

        if (!aliases.length) {
            return [];
        }

        const genericProviders = new Set(['custom', 'external']);
        const specificAliases = aliases.filter(
            (alias) => !genericProviders.has(alias),
        );

        return [...new Set(specificAliases.length ? specificAliases : aliases)];
    }

    private resolveFetcherPolicy(
        policy: SkillFetcherPolicy | undefined,
    ): Required<SkillFetcherPolicy> {
        return {
            toolMode: policy?.toolMode ?? 'any',
            allowWithoutTools: policy?.allowWithoutTools ?? false,
        };
    }

    private resolveExecutionPolicy(
        policy: SkillExecutionPolicy | undefined,
        fetcherPolicy: Required<SkillFetcherPolicy>,
    ): ResolvedExecutionPolicy {
        const fallbackDefault = fetcherPolicy.allowWithoutTools
            ? 'fallback'
            : 'fail';

        return {
            onMissingMcp: policy?.onMissingMcp ?? fallbackDefault,
            onMcpConnectError: policy?.onMcpConnectError ?? fallbackDefault,
            fetcherTimeoutMs: policy?.fetcherTimeoutMs ?? 120_000,
            analyzerTimeoutMs: policy?.analyzerTimeoutMs ?? 120_000,
            fetcherMaxIterations: policy?.fetcherMaxIterations ?? 4,
            analyzerMaxIterations: policy?.analyzerMaxIterations ?? 1,
        };
    }

    private resolveRequiredTools(meta: SkillMeta, skillName: string): string[] {
        const explicitTools = meta.allowedTools ?? [];
        const { tools: capabilityTools, unknownCapabilities } =
            resolveCapabilityTools(
                meta.capabilities,
                meta.capabilityToolMap,
                meta.capabilityDefinitions,
            );

        if (unknownCapabilities.length > 0) {
            this.logger.warn(
                `[GenericSkillRunner] Unknown capabilities in skill '${skillName}': ${unknownCapabilities.join(
                    ', ',
                )}`,
            );
        }

        return [...new Set([...explicitTools, ...capabilityTools])];
    }

    private normalizeToolExecutionResponse(
        response: unknown,
    ): ToolExecutionResponse {
        if (response && typeof response === 'object') {
            const maybeResult = (response as Record<string, unknown>).result;
            if (maybeResult !== undefined) {
                return { result: maybeResult };
            }
        }

        return { result: response };
    }

    private validateSkillSchema(meta: SkillMeta, skillName: string): void {
        if (!meta.name?.trim()) {
            this.logger.warn(
                `[GenericSkillRunner] Skill '${skillName}' is missing frontmatter 'name' (Agent Skills required field).`,
            );
        }

        if (!meta.description?.trim()) {
            this.logger.warn(
                `[GenericSkillRunner] Skill '${skillName}' is missing frontmatter 'description' (Agent Skills required field).`,
            );
        }

        if (meta.name && meta.name !== skillName) {
            this.logger.warn(
                `[GenericSkillRunner] Skill name mismatch. folder='${skillName}', frontmatter='${meta.name}'.`,
            );
        }
    }

    private hasRequiredKodusTools(
        servers: McpConnection[] | undefined,
        requiredTools: string[],
        fetcherPolicy: Required<SkillFetcherPolicy>,
    ): boolean {
        if (!requiredTools.length) {
            return true;
        }

        const kodusTools = new Set<string>();
        for (const server of servers ?? []) {
            if (server?.provider !== 'kodusmcp') {
                continue;
            }
            const tools = Array.isArray(server?.allowedTools)
                ? server.allowedTools
                : [];
            for (const tool of tools) {
                kodusTools.add(tool);
            }
        }

        if (fetcherPolicy.toolMode === 'all') {
            return requiredTools.every((tool) => kodusTools.has(tool));
        }

        return requiredTools.some((tool) => kodusTools.has(tool));
    }

    private recordSetupMetric(
        skillName: string,
        stage: 'fetcher' | 'analyzer',
        status: 'success' | 'failed',
        startedAt: number,
    ): void {
        const labels = { skill: skillName, stage, status };
        this.metricsCollector?.recordHistogram(
            'kodus_skill_setup_duration_ms',
            Date.now() - startedAt,
            labels,
        );
        this.metricsCollector?.recordCounter(
            'kodus_skill_setup_total',
            1,
            labels,
        );
    }
}
