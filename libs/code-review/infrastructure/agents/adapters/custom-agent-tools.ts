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
import type {
    MCPAdapter,
    MCPAdapterConfig,
    MCPServerConfig,
} from '@libs/mcp-server/mcp-adapter';
import { buildAstGrepTool } from './ast-grep.tool';
import {
    buildCustomAgentMcpTools,
    type CustomAgentMcpServer,
} from './custom-agent-mcp.tools';

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
    };
}

export interface CustomAgentToolset {
    tools: AgentTool[];
    close(): Promise<void>;
}

export async function buildCustomAgentTools(
    agent: Pick<CustomAgentConfig, 'tools'>,
    deps: CustomAgentToolDeps,
): Promise<CustomAgentToolset> {
    const tools: AgentTool[] = [];
    const closers: Array<() => Promise<void>> = [];

    // ast-grep needs the neutral config written before any run (see the tool),
    // so without a file writer it is not offered at all.
    if (deps.remoteCommands?.exec && deps.writeFile) {
        tools.push(
            buildAstGrepTool({
                exec: deps.remoteCommands.exec,
                writeFile: deps.writeFile,
                changedFiles: deps.changedFiles,
                rulesPath: agent.tools?.astGrepConfig?.trim() || undefined,
                readTargetFile: deps.readTargetFile,
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
            });
            tools.push(...mcp.tools);
            closers.push(() => mcp.close());
        } catch (error) {
            logger.warn({
                message:
                    'Custom agent MCP tools unavailable; running without them',
                context: 'buildCustomAgentTools',
                error,
            });
        }
    }

    return {
        tools,
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
            wanted.has(c.integrationId),
    );
    if (owned.length === 0) return [];

    const formatted = (await mcpManager.getConnections(
        organizationAndTeamData,
        true,
    )) as MCPServerConfig[];

    const servers: CustomAgentMcpServer[] = [];
    for (const connection of owned) {
        const config = (formatted ?? []).find(
            (f) => f.name === connection.appName,
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
