/**
 * code-review (domain) — read-only MCP tools for a custom review agent.
 *
 * An agent selects plugin connections (`tools.mcp[].integrationId`) and the
 * tool names it wants from each. What it is OFFERED is narrower: the selected
 * names that are also read-only. A server that annotates its tools is taken at
 * its word — only `readOnlyHint === true` passes, and an unannotated tool on
 * such a server stays out. A server that annotates nothing is judged by the
 * tool name against an allowlist: the name must carry a read verb (get, list,
 * search, ...) and no write verb. A blocklist of write verbs alone is not
 * enough — `archive_page` or `run_pipeline` would pass it. Either way the tool
 * must also be one the user selected. A review must never create a ticket or
 * post a message on the team's behalf, so over-excluding a read tool is the
 * cheap side of the trade.
 *
 * Execution goes through `call`, which refuses any name outside the allowed
 * set, whatever the model asks for. Failures and timeouts come back as tool
 * output (`isError`), never thrown — the loop recovers and the review goes on.
 *
 * One adapter per server, so a tool is always executed on the server it was
 * listed from (two servers may share a tool name). The model sees
 * `Server__tool`: provider tool names only allow `[A-Za-z0-9_-]`, so the
 * `Server:tool` form is kept for the description.
 *
 * A successful call is kept for the review run (`cache`, keyed by connection,
 * tool and arguments): the finder, the recall pass and the verifiers ask the
 * same question with fresh histories, and the answer does not change.
 */
import type {
    AgentTool,
    ToolContext,
    ToolResult,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import {
    MCP_ALL_READ_TOOLS,
    type CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { createLogger } from '@libs/core/log/logger';
import {
    createMCPAdapter,
    type MCPAdapter,
    type MCPAdapterConfig,
    type MCPServerConfig,
    type MCPToolRaw,
} from '@libs/mcp-server/mcp-adapter';
import { RunToolCache, stableKey } from './run-tool-cache';

const logger = createLogger('custom-agent-mcp-tools');

export const DEFAULT_MCP_CALL_TIMEOUT_MS = 20_000;
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 10_000;
const MAX_MCP_OUTPUT = 10_000;
const MAX_TOOL_NAME = 64;

/** Verbs that let an unannotated tool through: its name must carry one. */
const READ_VERBS =
    /^(get|list|search|read|find|fetch|query|describe|view|show|lookup|ask|check|inspect|validate|verify|explain|compare|count)(s|es|ing)?$/;

/** Verbs that keep an unannotated tool out even next to a read verb
 *  (`get_or_create_ticket`). Defense in depth, not the gate — so only words
 *  that are verbs, never nouns a read tool lists (`list_labels`, `get_runs`). */
const WRITE_VERBS =
    /^(create|update|delete|write|send|add|remove|set|edit|close|merge|archive|assign|transition|execute|exec|trigger|invoke|publish|upload|insert|upsert|patch|modify|rename|reset|revoke|grant|cancel|submit|approve|reject|reopen|apply|enable|disable|install|uninstall|purge|destroy|kill|restart|notify|invite|upgrade|restore|subscribe|unsubscribe|mark|replace|dismiss|mute|unmute|unlink|unlock|unpin|unstar|unwatch|unfollow|unassign|rerun|retry)(s|es|d|ed|ing)?$/;

export type CustomAgentMcpSelection = NonNullable<
    CustomAgentConfig['tools']['mcp']
>[number];

/** A formatted connection, tagged with the integration it came from. */
export interface CustomAgentMcpServer extends MCPServerConfig {
    integrationId: string;
}

export interface CustomAgentMcpToolset {
    tools: AgentTool[];
    /** Runs a tool by its exposed name; refuses anything outside `tools`. */
    call(name: string, args: unknown, ctx?: ToolContext): Promise<ToolResult>;
    /** Servers that were selected but could not be listed. */
    unavailable: string[];
    close(): Promise<void>;
}

function nameWords(name: string): string[] {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
}

export function isReadOnlyMcpTool(
    tool: Pick<MCPToolRaw, 'name' | 'annotations'>,
    serverMarksReadOnly: boolean,
): boolean {
    if (serverMarksReadOnly) {
        return tool.annotations?.readOnlyHint === true;
    }
    const words = nameWords(tool.name);
    if (words.some((w) => WRITE_VERBS.test(w))) return false;
    // `check in` / `check out` change state; `check` alone reads.
    if (
        words.some(
            (w, i) => w === 'check' && ['in', 'out'].includes(words[i + 1]),
        )
    ) {
        return false;
    }
    return words.some((w) => READ_VERBS.test(w));
}

function serverMarksReadOnly(tools: Array<Pick<MCPToolRaw, 'annotations'>>) {
    return tools.some((t) => typeof t.annotations?.readOnlyHint === 'boolean');
}

function sanitize(value: string): string {
    return value
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
}

export function mcpToolExposedName(server: string, tool: string): string {
    const s = sanitize(server) || 'mcp';
    const t = sanitize(tool) || 'tool';
    const full = `${s}__${t}`;
    if (full.length <= MAX_TOOL_NAME) return full;
    // Keep the tool part whole when possible: it is what the model reads.
    const room = Math.max(8, MAX_TOOL_NAME - t.length - 2);
    return `${s.slice(0, room)}__${t}`.slice(0, MAX_TOOL_NAME);
}

function stringify(result: unknown): string {
    if (typeof result === 'string') return result;
    // MCP `CallToolResult`: keep the text parts, which is what the model reads.
    const content = (result as { content?: unknown })?.content;
    if (Array.isArray(content)) {
        const text = content
            .map((part: any) =>
                part?.type === 'text' && typeof part.text === 'string'
                    ? part.text
                    : JSON.stringify(part),
            )
            .join('\n');
        if (text) return text;
    }
    return JSON.stringify(result ?? null);
}

function cap(output: string): string {
    return output.length > MAX_MCP_OUTPUT
        ? `${output.slice(0, MAX_MCP_OUTPUT)}\n... (truncated)`
        : output;
}

function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms}ms`)),
            ms,
        );
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error(`${label} was cancelled`));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * Drops the bound argument names from a tool's schema: the model does not
 * know the review's tenant or repository, so asking it for them only invites
 * a guess.
 */
function withoutBoundArgs(
    schema: JSONSchema,
    bound: Record<string, unknown> | undefined,
): JSONSchema {
    const names = Object.keys(bound ?? {});
    const properties = (schema as { properties?: Record<string, unknown> })
        .properties;
    if (!names.length || !properties) return schema;
    const kept = Object.fromEntries(
        Object.entries(properties).filter(([key]) => !names.includes(key)),
    );
    const required = (schema as { required?: string[] }).required;
    return {
        ...schema,
        properties: kept,
        ...(required
            ? { required: required.filter((key) => !names.includes(key)) }
            : {}),
    } as JSONSchema;
}

export async function buildCustomAgentMcpTools(params: {
    selections: readonly CustomAgentMcpSelection[];
    servers: readonly CustomAgentMcpServer[];
    createAdapter?: (config: MCPAdapterConfig) => MCPAdapter;
    callTimeoutMs?: number;
    connectTimeoutMs?: number;
    /**
     * Arguments the server fills in for every call to a connection, by
     * integration id: the review's tenant and repository for the Kodus
     * plugins. They are hidden from the model and always win over its input.
     */
    boundArgs?: Record<string, Record<string, unknown>>;
    /** Results kept for the review run; one per toolset when not given. */
    cache?: RunToolCache;
    /** The review's ids (organization, team, repository, PR, agent) for the logs. */
    logContext?: Record<string, unknown>;
}): Promise<CustomAgentMcpToolset> {
    const logContext = params.logContext ?? {};
    const cache = params.cache ?? new RunToolCache();
    const createAdapter = params.createAdapter ?? createMCPAdapter;
    const callTimeoutMs = params.callTimeoutMs ?? DEFAULT_MCP_CALL_TIMEOUT_MS;
    const connectTimeoutMs =
        params.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;

    const allowed = new Map<
        string,
        {
            adapter: MCPAdapter;
            integrationId: string;
            server: string;
            tool: string;
            bound?: Record<string, unknown>;
        }
    >();
    const tools: AgentTool[] = [];
    const adapters: Array<{
        adapter: MCPAdapter;
        server: string;
        integrationId: string;
    }> = [];
    const unavailable: string[] = [];

    for (const selection of params.selections ?? []) {
        const wanted = new Set(selection.tools ?? []);
        if (wanted.size === 0) continue;
        const wantsAll = wanted.has(MCP_ALL_READ_TOOLS);
        const server = params.servers.find(
            (s) => s.integrationId === selection.integrationId,
        );
        if (!server) {
            // The plugin was removed or disconnected after the agent picked it.
            logger.warn({
                message:
                    'Custom agent MCP connection not found; continuing without it',
                context: 'buildCustomAgentMcpTools',
                metadata: {
                    ...logContext,
                    integrationId: selection.integrationId,
                },
            });
            continue;
        }

        // The connection's own allow-list narrows further when it has one.
        const connectionAllows = server.allowedTools?.length
            ? new Set(server.allowedTools)
            : null;

        let adapter: MCPAdapter;
        let listed: MCPToolRaw[];
        try {
            adapter = createAdapter({
                servers: [server],
                defaultTimeout: callTimeoutMs,
                maxRetries: 0,
            });
            adapters.push({
                adapter,
                server: server.name,
                integrationId: selection.integrationId,
            });
            await withTimeout(
                adapter.connect(),
                connectTimeoutMs,
                `MCP ${server.name} connect`,
            );
            listed = await withTimeout(
                adapter.getTools(),
                connectTimeoutMs,
                `MCP ${server.name} list`,
            );
        } catch (error) {
            unavailable.push(server.name);
            logger.warn({
                message:
                    'Custom agent MCP server unavailable; continuing without it',
                context: 'buildCustomAgentMcpTools',
                error,
                metadata: {
                    ...logContext,
                    server: server.name,
                    integrationId: selection.integrationId,
                },
            });
            continue;
        }

        const marks = serverMarksReadOnly(listed);
        const bound = params.boundArgs?.[selection.integrationId];
        for (const raw of listed) {
            if (!wantsAll && !wanted.has(raw.name)) continue;
            if (connectionAllows && !connectionAllows.has(raw.name)) continue;
            if (!isReadOnlyMcpTool(raw, marks)) continue;

            const exposed = mcpToolExposedName(server.name, raw.name);
            if (allowed.has(exposed)) continue;
            allowed.set(exposed, {
                adapter,
                integrationId: selection.integrationId,
                server: server.name,
                tool: raw.name,
                bound,
            });
            tools.push({
                name: exposed,
                description:
                    `[${server.name}:${raw.name}] read-only. ${raw.description ?? ''}`.trim(),
                inputSchema: withoutBoundArgs(
                    ((raw.inputSchema as JSONSchema) ?? {
                        type: 'object',
                        properties: {},
                    }) as JSONSchema,
                    bound,
                ),
                execute: (input, ctx) => call(exposed, input, ctx),
            });
        }
    }

    async function call(
        name: string,
        args: unknown,
        ctx?: ToolContext,
    ): Promise<ToolResult> {
        const entry = allowed.get(name);
        if (!entry) {
            return {
                output: `MCP tool "${name}" is not allowed for this agent. Only read-only tools it selected can run.`,
                isError: true,
            };
        }
        const finalArgs = {
            ...((args ?? {}) as Record<string, unknown>),
            ...entry.bound,
        };
        return cache.getOrRun(
            ['mcp', entry.integrationId, entry.tool, stableKey(finalArgs)],
            () => execute(entry, finalArgs, ctx),
        );
    }

    async function execute(
        entry: { adapter: MCPAdapter; server: string; tool: string },
        finalArgs: Record<string, unknown>,
        ctx?: ToolContext,
    ): Promise<ToolResult> {
        try {
            const result = await withTimeout(
                entry.adapter.executeTool(entry.tool, finalArgs),
                callTimeoutMs,
                `MCP ${entry.server}:${entry.tool}`,
                ctx?.signal,
            );
            const isError = (result as { isError?: unknown })?.isError === true;
            return { output: cap(stringify(result)), isError };
        } catch (error) {
            // The arguments stay out of the log: only which tool failed.
            logger.warn({
                message: 'Custom agent MCP tool call failed',
                context: 'buildCustomAgentMcpTools',
                error,
                metadata: {
                    ...logContext,
                    server: entry.server,
                    tool: entry.tool,
                },
            });
            return {
                output: `MCP ${entry.server}:${entry.tool} failed: ${error instanceof Error ? error.message : String(error)}`,
                isError: true,
            };
        }
    }

    return {
        tools,
        call,
        unavailable,
        async close() {
            // Bounded like connect: a close that never settles would hold the
            // review. The timeout only stops waiting; the adapter is dropped.
            await Promise.allSettled(
                adapters.map(({ adapter, server, integrationId }) =>
                    withTimeout(
                        adapter.disconnect(),
                        connectTimeoutMs,
                        `MCP ${server} disconnect`,
                    ).catch((error) =>
                        logger.warn({
                            message: 'MCP disconnect failed or timed out',
                            context: 'buildCustomAgentMcpTools',
                            error,
                            metadata: {
                                ...logContext,
                                server,
                                integrationId,
                                connectTimeoutMs,
                            },
                        }),
                    ),
                ),
            );
        },
    };
}

/** One connection and the read-only tools it offers (the settings picker). */
export interface ReadOnlyMcpListing {
    integrationId: string;
    name: string;
    tools: Array<{ name: string; description?: string }>;
}

/**
 * The read-only tools each connection offers, by the same rule a run applies,
 * so the settings screen can only offer what a review would accept. A server
 * that cannot be reached is listed with no tools.
 */
export async function listReadOnlyMcpTools(params: {
    servers: readonly CustomAgentMcpServer[];
    createAdapter?: (config: MCPAdapterConfig) => MCPAdapter;
    connectTimeoutMs?: number;
}): Promise<ReadOnlyMcpListing[]> {
    const createAdapter = params.createAdapter ?? createMCPAdapter;
    const timeoutMs = params.connectTimeoutMs ?? DEFAULT_MCP_CONNECT_TIMEOUT_MS;

    return Promise.all(
        params.servers.map(async (server) => {
            const listing: ReadOnlyMcpListing = {
                integrationId: server.integrationId,
                name: server.name,
                tools: [],
            };
            let adapter: MCPAdapter | undefined;
            try {
                adapter = createAdapter({
                    servers: [server],
                    defaultTimeout: timeoutMs,
                    maxRetries: 0,
                });
                await withTimeout(
                    adapter.connect(),
                    timeoutMs,
                    `MCP ${server.name} connect`,
                );
                const listed = await withTimeout(
                    adapter.getTools(),
                    timeoutMs,
                    `MCP ${server.name} list`,
                );
                const marks = serverMarksReadOnly(listed);
                const connectionAllows = server.allowedTools?.length
                    ? new Set(server.allowedTools)
                    : null;
                listing.tools = listed
                    .filter(
                        (raw) =>
                            (!connectionAllows ||
                                connectionAllows.has(raw.name)) &&
                            isReadOnlyMcpTool(raw, marks),
                    )
                    .map((raw) => ({
                        name: raw.name,
                        description: raw.description,
                    }));
            } catch (error) {
                logger.warn({
                    message: 'MCP server unavailable while listing tools',
                    context: 'listReadOnlyMcpTools',
                    error,
                    metadata: { server: server.name },
                });
            } finally {
                if (adapter) {
                    await withTimeout(
                        adapter.disconnect(),
                        timeoutMs,
                        'MCP disconnect',
                    ).catch(() => undefined);
                }
            }
            return listing;
        }),
    );
}
