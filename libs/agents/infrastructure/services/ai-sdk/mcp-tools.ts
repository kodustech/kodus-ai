import { createLogger } from '@libs/core/log/logger';
import {
    createMCPAdapter,
    type MCPServerConfig,
} from '@libs/mcp-server/mcp-adapter';
import { PROACTIVE_HINT_META_KEY } from '@libs/mcp-server/types/mcp-tool.interface';
import { isFirstPartyMcpIntegration } from '@libs/mcp-server/utils/mcp-auth.constants';
import { jsonSchema, tool, type Tool } from 'ai';

const logger = createLogger('connectMcpTools');

export type { MCPServerConfig };

/**
 * What a tool declares about itself (MCP tool annotations). Carried beside the
 * tool map rather than inside it: the AI SDK `Tool` type has no slot for this,
 * and consumers (audit, proactive offers) need it without the model seeing it.
 */
export interface McpToolMetadata {
    /** False when the tool mutates state. Absent when the server omits it. */
    readOnlyHint?: boolean;
    /** True when the effect is irreversible. */
    destructiveHint?: boolean;
    /**
     * When an agent should offer this action, if it may offer it at all. Read
     * from the tool's `_meta`, and only from a first-party server: the line
     * goes into the agent's prompt.
     */
    proactiveHint?: string;
}

export interface ConnectedMcpTools {
    /** Tool map ready to spread into `generateText({ tools })`. */
    tools: Record<string, Tool>;
    /** Per-tool annotations, keyed by the same names as `tools`. */
    metadata: Record<string, McpToolMetadata>;
    /** Disconnects the underlying local MCP adapter. Always call in a finally. */
    close: () => Promise<void>;
}

/**
 * Connect to a set of MCP servers and expose their tools as Vercel AI SDK
 * tools, **backed by the local MCP adapter** (`@libs/mcp-server/mcp-adapter`'s
 * `createMCPAdapter`).
 *
 * The local MCP adapter is the MCP transport/auth/retry layer — it is
 * battle-tested for the kodus servers (HTTP/SSE, bearer/api-key/basic auth,
 * connection routing). This helper is just the thin bridge that turns the
 * adapter's tools into AI SDK `tool()` entries so the migrated agents run their
 * loop on the AI SDK while MCP keeps going through the local adapter.
 *
 * Tool names are kept verbatim (no server prefix) to match the legacy
 * orchestration behavior — prompts reference bare names like
 * `KODUS_FIND_MEMORIES`. Tool execution is routed back through
 * `adapter.executeTool(name, args)`, which resolves the owning server.
 *
 * Never throws on connect failure: the error is reported via `onError` and the
 * agent runs with whatever tools connected (parity with the legacy
 * "MCP offline, proceed" path).
 */
export async function connectMcpTools(
    servers: MCPServerConfig[],
    opts: {
        defaultTimeout?: number;
        maxRetries?: number;
        onError?: (error: Error, serverName: string) => void;
    } = {},
): Promise<ConnectedMcpTools> {
    const { defaultTimeout = 60_000, maxRetries = 1, onError } = opts;

    const adapter = createMCPAdapter({
        servers,
        defaultTimeout,
        maxRetries,
        onError: (error, serverName) => onError?.(error, serverName),
    });

    try {
        await adapter.connect();
    } catch (error) {
        onError?.(
            error instanceof Error ? error : new Error(String(error)),
            'mcp-adapter',
        );
        return { tools: {}, metadata: {}, close: async () => undefined };
    }

    const tools: Record<string, Tool> = {};
    const metadata: Record<string, McpToolMetadata> = {};

    // Tools are attributed to servers by name, so a name any other server
    // also uses is not trusted.
    const otherServers = new Set(
        servers
            .filter((s) => !isFirstPartyMcpIntegration(s.integrationId))
            .map((s) => s.name),
    );
    const firstPartyServers = new Set(
        servers
            .filter((s) => isFirstPartyMcpIntegration(s.integrationId))
            .map((s) => s.name)
            .filter((name) => !otherServers.has(name)),
    );
    const ignoredHints: { tool: string; serverName?: string }[] = [];

    try {
        const mcpTools = await adapter.getTools();

        for (const mcpTool of mcpTools) {
            const hint = readProactiveHint(mcpTool._meta);
            const trusted = firstPartyServers.has(mcpTool.serverName ?? '');
            if (hint && !trusted) {
                ignoredHints.push({
                    tool: mcpTool.name,
                    serverName: mcpTool.serverName,
                });
            }
            metadata[mcpTool.name] = {
                ...readAnnotations(mcpTool.annotations),
                ...(hint && trusted ? { proactiveHint: hint } : {}),
            };
            tools[mcpTool.name] = tool({
                description: mcpTool.description ?? '',
                inputSchema: jsonSchema(
                    (mcpTool.inputSchema ?? {
                        type: 'object',
                        properties: {},
                    }) as Record<string, unknown>,
                ),
                execute: async (args: unknown) =>
                    normalizeToolResult(
                        await adapter.executeTool(
                            mcpTool.name,
                            (args ?? {}) as Record<string, unknown>,
                        ),
                    ),
            });
        }
    } catch (error) {
        onError?.(
            error instanceof Error ? error : new Error(String(error)),
            'mcp-adapter',
        );
    }

    if (ignoredHints.length) {
        logger.warn({
            message:
                'Ignored proactive hints from MCP servers that are not first-party',
            context: 'connectMcpTools',
            metadata: { ignoredHints },
        });
    }

    return {
        tools,
        metadata,
        close: async () => {
            await adapter.disconnect().catch(() => undefined);
        },
    };
}

/**
 * Read the annotation keys we act on, ignoring anything else a server sends.
 * Every field stays optional — a server that omits them is normal, and the
 * consumer decides what an unknown tool defaults to.
 */
function readAnnotations(raw: unknown): McpToolMetadata {
    if (!raw || typeof raw !== 'object') {
        return {};
    }

    const a = raw as Record<string, unknown>;
    return {
        ...(typeof a.readOnlyHint === 'boolean'
            ? { readOnlyHint: a.readOnlyHint }
            : {}),
        ...(typeof a.destructiveHint === 'boolean'
            ? { destructiveHint: a.destructiveHint }
            : {}),
    };
}

function readProactiveHint(meta: unknown): string | undefined {
    if (!meta || typeof meta !== 'object') {
        return undefined;
    }

    const hint = (meta as Record<string, unknown>)[PROACTIVE_HINT_META_KEY];
    return typeof hint === 'string' && hint ? hint : undefined;
}

/**
 * Flatten a flow MCP tool result into the value the AI SDK feeds back to the
 * model. The flow adapter already unwraps the MCP envelope, so strings pass
 * through and objects are JSON-stringified.
 */
function normalizeToolResult(result: unknown): string {
    if (typeof result === 'string') {
        return result;
    }
    return JSON.stringify(result ?? null);
}
