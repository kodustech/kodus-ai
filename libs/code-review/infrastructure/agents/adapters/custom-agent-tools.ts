/**
 * code-review (domain) — the extra tools a custom review agent gets on top of
 * the finder's repository tools: `astGrep` and its read-only MCP tools.
 *
 * The caller (the custom agent provider) builds these per run and passes them
 * to the finder registry as `extraTools`, then calls `close()` when the run
 * ends so MCP connections are not left open.
 */
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    buildAstGrepUnavailableWarning,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import type {
    MCPAdapter,
    MCPAdapterConfig,
    MCPServerConfig,
} from '@libs/mcp-server/mcp-adapter';
import { KODUS_MCP_INTEGRATION_ID } from '@libs/mcp-server/services/mcp-manager.service';
import { buildAstGrepTool } from './ast-grep.tool';
import {
    buildCustomAgentMcpTools,
    type CustomAgentMcpServer,
} from './custom-agent-mcp.tools';
import type { RunToolCache } from './run-tool-cache';

const logger = createLogger('custom-agent-tools');

export interface CustomAgentToolDeps {
    remoteCommands?: RemoteCommands;
    /** Writes a repository-relative file inside the sandbox (see `sandboxFileWriter`). */
    writeFile?: (repoRelativePath: string, content: string) => Promise<void>;
    changedFiles: readonly string[];
    /** Reads a file from the PR target branch; null when it is not there. */
    readTargetFile?: (path: string) => Promise<string | null>;
    mcp?: {
        loadServers: (
            integrationIds: string[],
        ) => Promise<CustomAgentMcpServer[]>;
        createAdapter?: (config: MCPAdapterConfig) => MCPAdapter;
        callTimeoutMs?: number;
        /** Arguments filled in server-side per connection (see `buildCustomAgentMcpTools`). */
        boundArgs?: Record<string, Record<string, unknown>>;
        /** Call results kept for the review run (see `RunToolCache`). */
        cache?: RunToolCache;
    };
    /** Review identifiers (organization, team, repository, PR, agent) for logs. */
    logContext?: Record<string, unknown>;
}

export interface CustomAgentToolset {
    tools: AgentTool[];
    /** Names of the read-only MCP tools among `tools`. */
    teamSystemTools: string[];
    /** Tools the agent should have had but runs without, for the review. */
    warnings: ReviewWarning[];
    close(): Promise<void>;
}

async function hasAstGrep(
    exec: NonNullable<RemoteCommands['exec']>,
    logContext?: Record<string, unknown>,
): Promise<boolean> {
    try {
        const result = await exec('ast-grep --version');
        if (result.exitCode === 0) return true;
    } catch {
        // Reported below like a missing binary.
    }
    logger.warn({
        message:
            'ast-grep is not installed in the sandbox; astGrep is not offered',
        context: 'buildCustomAgentTools',
        metadata: logContext,
    });
    return false;
}

export async function buildCustomAgentTools(
    agent: Pick<CustomAgentConfig, 'tools'> &
        Partial<Pick<CustomAgentConfig, 'name'>>,
    deps: CustomAgentToolDeps,
): Promise<CustomAgentToolset> {
    const tools: AgentTool[] = [];
    const teamSystemTools: string[] = [];
    const warnings: ReviewWarning[] = [];
    const closers: Array<() => Promise<void>> = [];

    // ast-grep needs the neutral config written before any run (see the tool),
    // so without a file writer it is not offered at all; nor on a sandbox
    // image that predates the binary, where every call would fail. The latter
    // is reported: every custom agent gets astGrep, so its absence is a loss.
    const canRunAstGrep =
        !!deps.remoteCommands?.exec && !!deps.writeFile;
    const astGrepInstalled =
        canRunAstGrep &&
        (await hasAstGrep(deps.remoteCommands!.exec!, deps.logContext));
    if (canRunAstGrep && !astGrepInstalled) {
        warnings.push(
            buildAstGrepUnavailableWarning({
                agentName: agent.name || 'Custom agent',
            }),
        );
    }
    if (astGrepInstalled) {
        tools.push(
            buildAstGrepTool({
                exec: deps.remoteCommands!.exec!,
                writeFile: deps.writeFile!,
                changedFiles: deps.changedFiles,
                rules: agent.tools?.astGrepConfig?.trim() || undefined,
                logContext: deps.logContext,
            }) as AgentTool,
        );
    }

    const selections = (agent.tools?.mcp ?? []).filter(
        (s) => s.integrationId && s.tools?.length,
    );
    if (selections.length && deps.mcp) {
        try {
            const servers = await deps.mcp.loadServers(
                selections.map((s) => s.integrationId),
            );
            const mcp = await buildCustomAgentMcpTools({
                selections,
                servers,
                createAdapter: deps.mcp.createAdapter,
                callTimeoutMs: deps.mcp.callTimeoutMs,
                boundArgs: deps.mcp.boundArgs,
                cache: deps.mcp.cache,
            });
            tools.push(...mcp.tools);
            teamSystemTools.push(...mcp.tools.map((t) => t.name));
            closers.push(() => mcp.close());
        } catch (error) {
            logger.warn({
                message:
                    'Custom agent MCP tools unavailable; running without them',
                context: 'buildCustomAgentTools',
                error,
                metadata: deps.logContext,
            });
        }
    }

    return {
        tools,
        teamSystemTools,
        warnings,
        async close() {
            await Promise.allSettled(closers.map((c) => c()));
        },
    };
}

/**
 * Resolves the agent's selected plugin connections to MCP server configs.
 * Raw connections are filtered to the caller's organization before anything
 * is matched, so a connection of another tenant can never be selected.
 */
export async function loadCustomAgentMcpServers(
    mcpManager: {
        getConnections(
            organizationAndTeamData: OrganizationAndTeamData,
            format?: boolean,
        ): Promise<unknown[]>;
    },
    organizationAndTeamData: OrganizationAndTeamData,
    integrationIds: readonly string[],
): Promise<CustomAgentMcpServer[]> {
    const wanted = new Set(integrationIds);
    const raw = (await mcpManager.getConnections(
        organizationAndTeamData,
        false,
    )) as Array<{
        organizationId?: string;
        integrationId?: string;
        appName?: string;
    }>;
    const owned = (raw ?? []).filter(
        (c) =>
            c.organizationId === organizationAndTeamData.organizationId &&
            !!c.integrationId &&
            // The review already gives every agent the code, the pull request
            // and the memories the Kodus MCP would read.
            c.integrationId !== KODUS_MCP_INTEGRATION_ID &&
            wanted.has(c.integrationId),
    );
    if (owned.length === 0) return [];

    const formatted = (await mcpManager.getConnections(
        organizationAndTeamData,
        true,
    )) as MCPServerConfig[];

    const servers: CustomAgentMcpServer[] = [];
    for (const connection of owned) {
        // By the connection's integration id: two connections can share a
        // name, and a name match would hand one the other's credentials.
        const config = (formatted ?? []).find(
            (f) => f.integrationId === connection.integrationId,
        );
        if (config) {
            servers.push({
                ...config,
                integrationId: connection.integrationId!,
            });
        }
    }
    return servers;
}

/** Adapts a sandbox's absolute-path writer to the repository-relative one the
 *  tools take. Both providers accept an absolute path inside `repoDir`. */
export function sandboxFileWriter(sandbox: {
    repoDir: string;
    writeFile(path: string, content: string): Promise<void>;
}): (repoRelativePath: string, content: string) => Promise<void> {
    const root = sandbox.repoDir.replace(/\/+$/, '');
    return (repoRelativePath, content) =>
        sandbox.writeFile(
            `${root}/${repoRelativePath.replace(/^\/+/, '')}`,
            content,
        );
}
