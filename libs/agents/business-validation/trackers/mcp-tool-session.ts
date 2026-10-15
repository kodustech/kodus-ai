import type {
    CallToolResult,
    TextContent,
} from '@modelcontextprotocol/sdk/types.js';

import {
    createMCPAdapter,
    type MCPAdapter,
    type MCPServerConfig,
    type MCPToolRaw,
} from '@libs/mcp-server/mcp-adapter';

/** The tracker answered that the task does not exist. */
export class TaskNotFoundError extends Error {}

/** The tracker could not be reached, or failed for a reason other than "not found". */
export class TrackerUnavailableError extends Error {}

const NOT_FOUND_PATTERN =
    /\b(?:not[\s_-]?found|object_not_found|does(?: not|n't) exist|could(?: not|n't) find|unable to find|no (?:such )?(?:issue|task|ticket|work ?item|page|record)s?\b|404)\b/i;
/**
 * Shortcut's answer for a missing story, and nothing more: the same words
 * followed by a cause (`…: Request failed with status code 503`) are a
 * failure to read, not an absence.
 */
const RETRIEVE_FAILED_FOR_ID =
    /\bfailed to retrieve [\w\s]{0,40}? with (?:public )?id\W*[\w-]+\W*$/i;

/**
 * ClickUp's whole answer for a task id that is not one of the workspace's,
 * custom ids too. The server answered; it just has no such task.
 */
const CLICKUP_NO_SUCH_TASK = /^\W*(?:error\W*)?team not authorized\W*$/i;

/**
 * One MCP server, opened only for the tools a tracker reads with. Tools the
 * session is not given do not exist for it, so a fetch can never call a tool
 * that writes to the customer's tracker.
 */
export class McpToolSession {
    private adapter?: MCPAdapter;
    private connecting?: Promise<MCPAdapter>;
    /** Every tool called through this session, in order. */
    readonly called: string[] = [];

    constructor(
        private readonly server: MCPServerConfig,
        private readonly allowedTools?: string[],
    ) {}

    async tools(): Promise<MCPToolRaw[]> {
        const adapter = await this.connect();
        return adapter.getTools();
    }

    /** Calls a tool and returns its payload: the structured content, or the parsed text. */
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        // Listing filters by `allowedTools`; executing does not. Enforce it here.
        if (this.allowedTools && !this.allowedTools.includes(name)) {
            throw new TrackerUnavailableError(
                `Tool ${name} is not open to this session`,
            );
        }
        const adapter = await this.connect();
        this.called.push(name);
        let result: unknown;
        try {
            result = await adapter.executeTool(name, args, this.server.name);
        } catch (error) {
            throw trackerError(
                error instanceof Error ? error.message : String(error),
            );
        }
        if ((result as CallToolResult | undefined)?.isError) {
            // A tool that reports a failure answered nothing about the task.
            const payload = readToolPayload(result);
            throw trackerError(
                typeof payload === 'string'
                    ? payload
                    : (JSON.stringify(payload) ?? `${name} failed`),
            );
        }
        return readToolPayload(result);
    }

    async close(): Promise<void> {
        const adapter = this.adapter;
        this.adapter = undefined;
        this.connecting = undefined;
        await adapter?.disconnect().catch(() => undefined);
    }

    private connect(): Promise<MCPAdapter> {
        if (this.adapter) {
            return Promise.resolve(this.adapter);
        }
        this.connecting ??= (async () => {
            const serverTools = new Set(this.server.allowedTools ?? []);
            const allowed = this.allowedTools
                ? this.allowedTools.filter(
                      (tool) => !serverTools.size || serverTools.has(tool),
                  )
                : this.server.allowedTools;
            const adapter = createMCPAdapter({
                servers: [{ ...this.server, allowedTools: allowed }],
                defaultTimeout: 15_000,
                maxRetries: 1,
            });
            try {
                await adapter.connect();
            } catch (error) {
                await adapter.disconnect().catch(() => undefined);
                throw new TrackerUnavailableError(
                    error instanceof Error ? error.message : String(error),
                );
            }
            this.adapter = adapter;
            return adapter;
        })();
        return this.connecting;
    }
}

/** What a tool returned, without the MCP envelope. */
export function readToolPayload(result: unknown): unknown {
    if (!result || typeof result !== 'object') {
        return result;
    }
    const record = result as Partial<CallToolResult>;
    if (record.structuredContent !== undefined) {
        return record.structuredContent;
    }
    if (!Array.isArray(record.content)) {
        return result;
    }
    const text = record.content
        .filter(
            (item): item is TextContent =>
                item?.type === 'text' && typeof item.text === 'string',
        )
        .map((item) => item.text)
        .join('\n')
        .trim();
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** What the MCP adapter puts before a tool's own answer when it throws it. */
const ADAPTER_PREFIX = /^\s*Tool \S+ failed:\s*/i;

function trackerError(message: string): Error {
    const answer = message.replace(ADAPTER_PREFIX, '').trim();
    return NOT_FOUND_PATTERN.test(message) ||
        RETRIEVE_FAILED_FOR_ID.test(answer) ||
        CLICKUP_NO_SUCH_TASK.test(answer)
        ? new TaskNotFoundError(message)
        : new TrackerUnavailableError(message);
}
