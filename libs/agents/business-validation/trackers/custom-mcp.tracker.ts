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

    constructor(
        readonly name: string,
        session: McpToolSession,
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
            if (!args) {
                continue;
            }
            let payload: unknown;
            try {
                payload = await this.session.call(tool.name, args);
            } catch (error) {
                if (error instanceof TaskNotFoundError) {
                    continue;
                }
                throw error;
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

    private loadReaders(): Promise<MCPToolRaw[]> {
        this.readers ??= this.session
            .tools()
            .then((tools) => tools.filter(isSingleItemReader));
        return this.readers;
    }
}

export function isSingleItemReader(tool: MCPToolRaw): boolean {
    const annotations = asRecord(tool.annotations);
    if (
        annotations.readOnlyHint === false ||
        annotations.destructiveHint === true
    ) {
        return false;
    }
    if (
        WRITE_VERB.test(tool.name) ||
        !TASK_NOUN.test(tool.name) ||
        MANY.test(tool.name)
    ) {
        return false;
    }
    return idParam(asRecord(tool.inputSchema) as Schema) !== undefined;
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
