import {
    createMCPAdapter,
    type MCPServerConfig,
} from '@libs/mcp-server/mcp-adapter';
import { jsonSchema, tool, type Tool } from 'ai';

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
    /** When an agent should offer this action, if it may offer it at all. */
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

    try {
        const mcpTools = await adapter.getTools();

        for (const mcpTool of mcpTools) {
            metadata[mcpTool.name] = readAnnotations(mcpTool.annotations);
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
        ...(typeof a.proactiveHint === 'string' && a.proactiveHint
            ? { proactiveHint: a.proactiveHint }
            : {}),
    };
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
