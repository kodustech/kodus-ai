import {
    createMCPAdapter,
    MCPAdapter,
    MCPServerConfig,
} from '@libs/mcp-server/mcp-adapter';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { BYOKConfig } from '@kodus/kodus-common/llm';

import type { ToolRegistry } from '@libs/agent-harness/domain/contracts';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

import {
    buildMcpAgentToolRegistry,
    runMcpFetcherAgent,
} from './runtime/ai-sdk-fetcher.adapter';
import { BoundedMap } from './runtime/bounded-map';
import {
    AgentThread,
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
    thread?: AgentThread;
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
> &
    // Optional (off by default): a skill opts into fetcher compression by
    // declaring its model's real context window in SKILL.md, and/or into the
    // analyzer verify gate.
    Pick<SkillExecutionPolicy, 'contextWindowTokens' | 'verifyAnalyzerResult'>;

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
        @Optional() private readonly byokErrorCounter?: ByokErrorCounter,
    ) {}

    /**
     * Creates a ready-to-use fetcher orchestration for a skill.
     * Connects MCP tools based on SKILL.md allowed-tools frontmatter.
     */
    async createFetcherOrchestration(
        skillName: string,
        byokConfig: BYOKConfig | undefined,
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
            const requiredCategories = this.resolveRequiredCategories(
                meta.requiredMcps,
            );

            this.preflightRequiredMcps(
                skillName,
                meta.requiredMcps,
                requiredProviderHints,
                requiredCategories,
                availableProviders,
                mcpManagerServers,
            );

            const mcpAdapter = this.createMCPAdapter(
                skillName,
                requiredTools,
                fetcherPolicy,
                requiredProviderHints,
                requiredCategories,
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

            // Connect the local MCP adapter (transport/auth/retry stays in the
            // local adapter, per the migration directive) and expose its tools as harness
            // AgentTools. The agent loop now runs on the AI SDK via
            // AiSdkAgentRunner — no flow-engine orchestration / REACT planner.
            let toolRegistry: ToolRegistry = {
                get: () => undefined,
                list: () => [],
            };
            if (mcpAdapter) {
                try {
                    await mcpAdapter.connect();
                    toolRegistry =
                        await buildMcpAgentToolRegistry(mcpAdapter);

                    const registeredTools = toolRegistry.list();
                    this.logger.log({
                        message: `[GenericSkillRunner] MCP tools registered for skill '${skillName}'`,
                        context: 'createFetcherOrchestration',
                        metadata: {
                            skillName,
                            registeredToolCount: registeredTools.length,
                            registeredToolNames: registeredTools.map(
                                (t) => t.name,
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

            const fetcherSystemPrompt =
                `Context fetcher for ${skillName}.\n\n` +
                `Goal: Fetch all relevant context for the ${skillName} skill ` +
                `using available tools. Return structured JSON with the ` +
                `gathered data.`;

            const toolCaller: ToolCaller = {
                // Deterministic capability fetches (PR diff/metadata) run through
                // the SAME harness ToolRegistry/AgentTools as the agentic fetcher
                // — no direct mcpAdapter bypass. The MCP AgentTool stringifies the
                // raw adapter envelope into `output`; we parse it back so the
                // shape reaching the extractors is identical to before.
                callTool: async (toolName, args) => {
                    const tool = toolRegistry.get(toolName);
                    if (!tool) {
                        return this.normalizeToolExecutionResponse(undefined);
                    }
                    const toolResult = await tool.execute(args, {
                        runId: `${skillName}:deterministic`,
                    });
                    if (toolResult.isError) {
                        return this.normalizeToolExecutionResponse(undefined);
                    }
                    return this.normalizeToolExecutionResponse(
                        this.parseAgentToolOutput(toolResult.output),
                    );
                },
                callAgent: async (agentName, prompt) => {
                    // Standard run context: signal + hard timeout via the shared
                    // helper — same guarantee as the code-review and conversation
                    // agents (replaces the hand-rolled AbortController+setTimeout).
                    // The per-skill `fetcherTimeoutMs` is kept as the ceiling, and
                    // composeAbortSignal lets a parent cancellation propagate in.
                    const { ctx, cleanup } = createAgentRunContext({
                        runId: `${skillName}:${agentName}`,
                        timeoutMs: executionPolicy.fetcherTimeoutMs,
                    });
                    try {
                        // Wrapped in a billing span so token usage reaches the
                        // Mongo `observability_telemetry` cost dataset (parity
                        // with the legacy flow path).
                        const result =
                            await this.observabilityService.runAiSdkLLMInSpan({
                                spanName: `SkillFetcher::${skillName}`,
                                runName: `kodus-${skillName}-fetcher`,
                                model: byokConfig?.main?.model,
                                attrs: {
                                    type: 'agent',
                                    organizationId:
                                        organizationAndTeamData?.organizationId,
                                    teamId: organizationAndTeamData?.teamId,
                                    skill: skillName,
                                },
                                exec: () =>
                                    runMcpFetcherAgent({
                                        byokConfig,
                                        agentId: `kodus-${skillName}-fetcher`,
                                        systemPrompt: fetcherSystemPrompt,
                                        prompt,
                                        tools: toolRegistry,
                                        maxSteps:
                                            executionPolicy.fetcherMaxIterations,
                                        providerOptions: buildProviderOptions(
                                            `kodus-${skillName}-fetcher`,
                                            undefined,
                                            {
                                                // Effort tier from the org's
                                                // BYOK config; 'low' fallback.
                                                reasoningEffort:
                                                    byokConfig?.main
                                                        ?.reasoningEffort ??
                                                    'low',
                                                byokProvider:
                                                    byokConfig?.main?.provider,
                                                modelName:
                                                    byokConfig?.main?.model,
                                            },
                                        ),
                                        runId: ctx.runId,
                                        signal: ctx.signal,
                                        contextWindowTokens:
                                            executionPolicy.contextWindowTokens,
                                        reporter: this.byokErrorCounter
                                            ? (e) =>
                                                  void this.byokErrorCounter!.record(
                                                      e,
                                                  )
                                            : undefined,
                                        telemetry: {
                                            functionId: `kodus-${skillName}-fetcher`,
                                            organizationId:
                                                organizationAndTeamData?.organizationId,
                                            teamId: organizationAndTeamData?.teamId,
                                            provider:
                                                byokConfig?.main?.provider,
                                        },
                                    }),
                            });
                        return this.normalizeToolExecutionResponse(
                            result.text,
                        );
                    } finally {
                        cleanup();
                    }
                },
                getRegisteredTools: () =>
                    toolRegistry.list().map((t) => ({ name: t.name })),
                getToolsForLLM: () =>
                    toolRegistry.list().map((t) => ({
                        name: t.name,
                        parameters: t.inputSchema,
                    })),
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
        requiredCategories: Set<string>,
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

        // Prefer the canonical capability category stamped by the mcp-manager
        // registry (drift-proof: doesn't depend on the connection's display
        // name — "Git Issues" vs "Github Issues" no longer breaks the match).
        // Fall back to display-name hints for connections without a category
        // (external/custom MCPs the registry doesn't classify).
        const matchingExternalConnections = externalConnections.filter(
            (server) =>
                this.serverMatchesRequiredCategory(
                    server,
                    requiredCategories,
                ) ||
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
        requiredCategories: Set<string>,
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

                if (!requiredProviderHints.length && !requiredCategories.size) {
                    return true;
                }
                return (
                    this.serverMatchesRequiredCategory(
                        server,
                        requiredCategories,
                    ) ||
                    this.serverMatchesRequiredHints(
                        server,
                        requiredProviderHints,
                    )
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

    private resolveRequiredCategories(
        requiredMcps: SkillRequiredMcp[] | undefined,
    ): Set<string> {
        return new Set(
            (requiredMcps ?? [])
                .map((mcp) => mcp.category)
                .filter((c): c is string => typeof c === 'string'),
        );
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

    private serverMatchesRequiredCategory(
        server: McpConnection,
        requiredCategories: Set<string>,
    ): boolean {
        if (!requiredCategories.size) {
            return false;
        }
        return (
            typeof server?.category === 'string' &&
            requiredCategories.has(server.category)
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
            // Optional, off by default — only present when the SKILL.md declares it.
            contextWindowTokens: policy?.contextWindowTokens,
            verifyAnalyzerResult: policy?.verifyAnalyzerResult,
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

    /**
     * The harness MCP AgentTool returns `{ output }` where `output` is the raw
     * adapter response stringified (or a plain string). Parse JSON back to the
     * object so `normalizeToolExecutionResponse` sees the same shape the direct
     * adapter call used to produce; a non-JSON string is passed through as-is.
     */
    private parseAgentToolOutput(output: unknown): unknown {
        if (typeof output !== 'string') {
            return output;
        }
        try {
            return JSON.parse(output);
        } catch {
            return output;
        }
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
