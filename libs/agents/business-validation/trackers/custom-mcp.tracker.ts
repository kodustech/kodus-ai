import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import { mentions, recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

/** Verbs that change something. A tool named with one is never called. */
const WRITE_VERB =
    /(^|[_\-\s.]|[a-z](?=[A-Z]))(create|update|delete|remove|upsert|write|add|set|edit|patch|put|post|send|move|merge|close|reopen|assign|transition|archive|link|unlink|lock|vote|run|cancel|retry|comment|import|upload|replace|dismiss|approve|reject)/i;
/** What a task is called across trackers. */
const TASK_NOUN =
    /(issue|task|ticket|story|bug|epic|card|work_?item|workitem)/i;
/** A plural noun or a list/search verb: returns many items, not the one asked for. */
const MANY =
    /(list|search|query|find|all|batch|backlog)|(issues|tasks|tickets|items|stories|cards)\b/i;
const ID_PARAM =
    /^(id|key|identifier|number|issue_?(id|key|number)|issueIdOrKey|task_?id|ticket_?id|work_?item_?id|workItemId|item_?id)$/i;

const MAX_TOOLS_TRIED = 2;

/**
 * Reads a task through one tool when the arguments can't be filled from the
 * schema alone: an agent that sees only that tool (phase 6).
 */
export type AgentToolReader = (input: {
    tool: MCPToolRaw;
    reference: TaskReference;
    call: (args: Record<string, unknown>) => Promise<unknown>;
}) => Promise<unknown>;

type Schema = {
    type?: string;
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
};

/**
 * A task tracker connected as a custom MCP plugin (#1884). Without a tool the
 * org chose, it picks tools that read one item by id: named after a task,
 * named with no verb that writes, not marked as writing, and with an id
 * argument it can fill. Every other tool is invisible to the fetch.
 */
export class CustomMcpTracker extends McpTaskTracker {
    private readers?: Promise<MCPToolRaw[]>;

    /**
     * @param tool The tool the org picked to read a task by its id. Without
     *   one, tools are picked by name and schema.
     */
    constructor(
        readonly name: string,
        session: McpToolSession,
        private readonly tool?: string,
        private readonly agentReader?: AgentToolReader,
    ) {
        super(session);
    }

    canRead(reference: TaskReference): boolean {
        return (
            (reference.kind === 'key' && reference.host === undefined) ||
            reference.kind === 'work_item'
        );
    }

    protected async lookup(reference: TaskReference): Promise<TrackerLookup> {
        const readers = await this.loadReaders();
        if (!readers.length) {
            return {
                status: 'error',
                message: `${this.name} has no tool that reads one task by its id`,
            };
        }

        for (const tool of readers.slice(0, MAX_TOOLS_TRIED)) {
            const args = buildReadArgs(tool, reference);
            let payload: unknown;
            try {
                payload = args
                    ? await this.session.call(tool.name, args)
                    : undefined;
            } catch (error) {
                if (error instanceof TaskNotFoundError) {
                    continue;
                }
                throw error;
            }
            if (!mentions(payload, reference.id) && this.chosen(tool)) {
                // The schema alone couldn't say how to ask for this id.
                payload = await this.readWithAgent(tool, reference);
            }
            if (!mentions(payload, reference.id)) {
                continue;
            }
            const item =
                recordsIn(payload).find((record) =>
                    mentions(
                        [
                            record.id,
                            record.key,
                            record.identifier,
                            record.number,
                        ],
                        reference.id,
                    ),
                ) ?? asRecord(payload);
            const fields = { ...item, ...asRecord(item.fields) };
            return {
                status: 'found',
                task: {
                    tracker: this.name,
                    id:
                        reference.kind === 'work_item'
                            ? `AB#${reference.id}`
                            : reference.id,
                    title: textField(fields, [
                        'System.Title',
                        'title',
                        'summary',
                        'name',
                    ]),
                    description:
                        textField(fields, [
                            'System.Description',
                            'description',
                            'body',
                            'Microsoft.VSTS.Common.AcceptanceCriteria',
                        ]) ??
                        (typeof payload === 'string' ? payload : undefined),
                },
            };
        }
        return { status: 'not_found' };
    }

    private chosen(tool: MCPToolRaw): boolean {
        return !!this.agentReader && tool.name === this.tool;
    }

    private async readWithAgent(
        tool: MCPToolRaw,
        reference: TaskReference,
    ): Promise<unknown> {
        try {
            return await this.agentReader!({
                tool,
                reference,
                call: (args) => this.session.call(tool.name, args),
            });
        } catch (error) {
            if (error instanceof TaskNotFoundError) {
                return undefined;
            }
            throw error;
        }
    }

    private loadReaders(): Promise<MCPToolRaw[]> {
        this.readers ??= this.session
            .tools()
            .then((tools) =>
                this.tool
                    ? tools.filter((t) => t.name === this.tool && isReadOnly(t))
                    : tools.filter(isSingleItemReader),
            );
        return this.readers;
    }
}

/** Never marked or named as writing. The bar for a tool the org picked itself. */
export function isReadOnly(tool: MCPToolRaw): boolean {
    const annotations = asRecord(tool.annotations);
    return (
        annotations.readOnlyHint !== false &&
        annotations.destructiveHint !== true &&
        !WRITE_VERB.test(tool.name)
    );
}

export function isSingleItemReader(tool: MCPToolRaw): boolean {
    if (
        !isReadOnly(tool) ||
        !TASK_NOUN.test(tool.name) ||
        MANY.test(tool.name)
    ) {
        return false;
    }
    return idParam(asRecord(tool.inputSchema) as Schema) !== undefined;
}

/**
 * The tools of a plugin an admin may pick to read a task by id, best first:
 * single-item readers, then other read-only tools that take an id.
 */
export function rankReadTools(tools: MCPToolRaw[]): Array<{
    name: string;
    description?: string;
    recommended: boolean;
}> {
    return tools
        .filter(
            (t) =>
                isReadOnly(t) &&
                idParam(asRecord(t.inputSchema) as Schema) !== undefined &&
                !MANY.test(t.name),
        )
        .map((t) => ({
            name: t.name,
            description: t.description,
            recommended: isSingleItemReader(t),
        }))
        .sort((a, b) => Number(b.recommended) - Number(a.recommended));
}

/** The arguments that read `reference`, or undefined when a required one can't be filled. */
export function buildReadArgs(
    tool: MCPToolRaw,
    reference: TaskReference,
): Record<string, unknown> | undefined {
    const schema = asRecord(tool.inputSchema) as Schema;
    const properties = schema.properties ?? {};
    const id = idParam(schema);
    if (!id) {
        return undefined;
    }

    const args: Record<string, unknown> = {};
    const numeric =
        properties[id]?.type === 'number' || properties[id]?.type === 'integer';
    if (numeric && !/^\d+$/.test(reference.id)) {
        return undefined;
    }
    args[id] = numeric ? Number(reference.id) : reference.id;

    for (const [name, property] of Object.entries(properties)) {
        if (name === id || !Array.isArray(property.enum)) {
            continue;
        }
        // A tool that reads and writes behind an `action` argument: only ever "get".
        const read = property.enum.find(
            (value) =>
                typeof value === 'string' &&
                /^(get|read|fetch|view)$/i.test(value),
        );
        if (read) {
            args[name] = read;
        }
    }

    const missing = (schema.required ?? []).filter(
        (name) => args[name] === undefined,
    );
    return missing.length ? undefined : args;
}

function idParam(schema: Schema): string | undefined {
    return Object.keys(schema.properties ?? {}).find((name) =>
        ID_PARAM.test(name),
    );
}
