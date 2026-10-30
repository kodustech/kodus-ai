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

/**
 * A tool the org turned off on the connection: the tracker answers, but is
 * set up so this read can't run. A setup problem, never an outage.
 */
export class ToolClosedError extends TrackerUnavailableError {}

/**
 * The tracker refused the id's shape (`Invalid id format`): whatever was
 * asked for is not one of its tasks, so no agent looks for it.
 */
const INVALID_ID =
    /\b(?:invalid|malformed|bad)\b[^.\n]{0,20}?\b(?:id|ids|key|identifier)\b/i;

/**
 * The tracker's own 404 for the item (`"statusCode": 404`, `404 Not found`):
 * no such item, in whatever language the rest of the message is written. A
 * client's `Request failed with status code 404` may be a wrong endpoint,
 * so it stays unavailable.
 */
const STATUS_404 =
    /\bstatus(?:_?code)?["']?\s*[:=]\s*404\b|\b404\W{0,3}not[\s_-]?found\b/i;

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

    /**
     * The tools this session may call: the tracker's own list, within what
     * the org left open on the connection. Undefined: every tool it lists.
     */
    private readonly allowed?: string[];
    /** A tracker's list, or the org's, bounds this session; an empty bound opens nothing. */
    private readonly restricted: boolean;

    constructor(
        private readonly server: MCPServerConfig,
        allowedTools?: string[],
    ) {
        const serverTools = new Set(server.allowedTools ?? []);
        this.allowed = allowedTools
            ? allowedTools.filter(
                  (tool) => !serverTools.size || serverTools.has(tool),
              )
            : server.allowedTools;
        this.restricted = !!allowedTools || serverTools.size > 0;
    }

    async tools(): Promise<MCPToolRaw[]> {
        const adapter = await this.connect();
        return adapter.getTools();
    }

    /** Calls a tool and returns its payload: the structured content, or the parsed text. */
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
        // Listing filters by `allowedTools`; executing does not. Enforce it
        // here, against what the org allows too.
        if (this.restricted && !this.allowed?.includes(name)) {
            throw new ToolClosedError(
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
                args,
            );
        }
        if ((result as CallToolResult | undefined)?.isError) {
            // A tool that reports a failure answered nothing about the task.
            const payload = readToolPayload(result);
            throw trackerError(
                typeof payload === 'string'
                    ? payload
                    : (JSON.stringify(payload) ?? `${name} failed`),
                args,
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
            const adapter = createMCPAdapter({
                servers: [{ ...this.server, allowedTools: this.allowed }],
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

/**
 * Something other than the task was not found (the site, the workspace, the
 * team), or the integration may not see it: the tracker is set up wrong for
 * this read, not missing the task.
 */
const NOT_THE_TASK =
    /\b(?:cloud_?id|site|workspace|organi[sz]ation|team|project|space|database|user|tool|resource|endpoint)s?\b[^.\n]{0,30}?\bnot[\s_-]?found\b|\bshared with (?:your|the|this) integration\b|\b(?:permission|access) (?:denied|required)\b|\b(?:no|lacks?|without) (?:permission|access)\b/i;

/**
 * "Not found" counts as "no such task" only when it is about the task asked
 * for: the message names it, or a task, or carries a 404 status (a tracker
 * answering in its user's language), and nothing else is missing. Anything
 * else is a tracker that could not read it, so the owners hear about it and
 * the PR is checked again, instead of a typo comment on the PR.
 */
function trackerError(message: string, args: Record<string, unknown>): Error {
    const answer = message.replace(ADAPTER_PREFIX, '').trim();
    if (
        RETRIEVE_FAILED_FOR_ID.test(answer) ||
        CLICKUP_NO_SUCH_TASK.test(answer)
    ) {
        return new TaskNotFoundError(message);
    }
    if (NOT_THE_TASK.test(answer)) {
        return new TrackerUnavailableError(message);
    }
    return STATUS_404.test(answer) ||
        INVALID_ID.test(answer) ||
        (NOT_FOUND_PATTERN.test(message) &&
            (TASK_NOUN.test(answer) || namesAsked(answer, args)))
        ? new TaskNotFoundError(message)
        : new TrackerUnavailableError(message);
}

const TASK_NOUN =
    /\b(?:issue|task|ticket|work ?item|story|bug|epic|card|page|item|record|entity)s?\b/i;

/** Whether the message names a value the call was given (the id it asked for). */
function namesAsked(answer: string, args: Record<string, unknown>): boolean {
    const text = answer.toLowerCase();
    return Object.values(args).some(
        (value) =>
            (typeof value === 'string' || typeof value === 'number') &&
            String(value).trim().length > 0 &&
            text.includes(String(value).toLowerCase()),
    );
}
