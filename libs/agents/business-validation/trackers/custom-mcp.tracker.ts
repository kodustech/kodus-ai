import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import { describeTask, mentions, recordsIn } from './task-payload';
import { McpTaskTracker, type TrackerReadContext } from './tracker';

/** Verbs that change something. A tool named with one is never called. */
const WRITE_VERBS =
    'create|update|delete|remove|upsert|write|add|set|save|edit|patch|put|post|send|move|merge|close|reopen|assign|transition|archive|link|unlink|lock|vote|run|cancel|retry|comment|import|upload|replace|dismiss|approve|reject|mark|share|unshare|submit|resolve|retire|restore|prepare|publish|toggle|enable|disable|trigger|execute|invoke|sync|rename|duplicate|subscribe|unsubscribe|invite|grant|revoke|install|uninstall|deploy|schedule|snooze';
const WRITE_WORD = new RegExp(`^(?:${WRITE_VERBS})$`, 'i');
const STARTS_WITH_WRITE = new RegExp(`^(?:${WRITE_VERBS})`, 'i');

/**
 * Whether a tool's name says it writes: one of its words is a write verb
 * (`save_issue`, `createIssue`, `DELETE_TASK`), or its first word starts with
 * one (`deleteissue`). A verb inside a later word is not one: `get_markdown`
 * and `list_bookmarks` read.
 */
function namesAWrite(name: string): boolean {
    const words = name
        .split(/[_\-\s.]+|(?<=[a-z0-9])(?=[A-Z])/)
        .filter(Boolean);
    return (
        STARTS_WITH_WRITE.test(words[0] ?? '') ||
        words.some((word) => WRITE_WORD.test(word))
    );
}

/** What a task is called across trackers. */
const TASK_NOUN =
    /(issue|task|ticket|story|bug|epic|card|work_?item|workitem)/i;
/** A plural noun or a list/search verb: returns many items, not the one asked for. */
const MANY =
    /(list|search|query|find|all|batch|backlog)|(issues|tasks|tickets|items|stories|cards)\b/i;
/**
 * What may follow the task noun in a reader's name: `get_issue`,
 * `issue_read`, `getIssueById`. Anything else reads something about the task
 * (`jira_get_issue_watchers`, `jira_get_issue_dates`), not the task.
 */
const AFTER_TASK_NOUN =
    /^.*(?:issue|task|ticket|story|bug|epic|card|work_?item|workitem)((?:[_\-\s.]?(?:by[_-]?)?(?:id|key|number|details?|get|read|fetch|view|info))*)$/i;
const ID_PARAM =
    /^(id|key|identifier|number|i?id|issue_?(id|iid|key|number)|issueIdOrKey|task|task_?id|ticket_?id|work_?item_?id|workItemId|item_?id|story_?public_?id)$/i;

/** Where a repository host's server takes the repository of `#12`. */
const OWNER_PARAM = /^owner$/i;
const REPO_PARAM = /^repo(sitory)?(_?name)?$/i;
const PROJECT_PATH_PARAM = /^project(_?(id|path))?$|^full_?name$/i;

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
    private tools?: Promise<MCPToolRaw[]>;

    /**
     * @param tool The tool the org picked to read a task by its id. Without
     *   one, tools are picked by name and schema.
     */
    constructor(
        readonly name: string,
        session: McpToolSession,
        private readonly tool?: string,
        private readonly agentReader?: AgentToolReader,
        /**
         * The org picked this plugin as its task source, so it also reads
         * `#12`: it is the repository host's own server (GitHub, GitLab).
         */
        private readonly chosenSource = false,
    ) {
        super(session);
    }

    canRead(reference: TaskReference): boolean {
        return (
            (reference.kind === 'key' && reference.host === undefined) ||
            reference.kind === 'work_item' ||
            (reference.kind === 'git_issue' && this.chosenSource)
        );
    }

    protected async lookup(
        reference: TaskReference,
        context: TrackerReadContext,
    ): Promise<TrackerLookup> {
        const repository =
            reference.kind === 'git_issue'
                ? (reference.repository ?? context.repository)
                : undefined;
        const listed = await this.loadTools();
        const readers = this.tool
            ? listed.filter((t) => t.name === this.tool && isReadOnly(t))
            : listed.filter(isSingleItemReader);
        if (!readers.length) {
            return {
                status: 'error',
                message: listed.length
                    ? `${this.name} has no tool that reads one task by its id`
                    : `${this.name} listed no tools`,
                // A server that listed nothing may have dropped the listing;
                // only one that listed tools and none reads is set up wrong.
                ...(listed.length ? { setup: true } : {}),
            };
        }

        // `#12` is read only through a tool that takes the repository: given
        // to a Jira tool it is an internal id, and reads an unrelated issue.
        const usable =
            reference.kind === 'git_issue'
                ? repository
                    ? readers.filter(takesRepository)
                    : []
                : readers;
        for (const tool of usable.slice(0, MAX_TOOLS_TRIED)) {
            const args = buildReadArgs(tool, reference, repository);
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
                            record.iid,
                            record.custom_id,
                        ],
                        reference.id,
                    ),
                ) ?? asRecord(payload);
            if (item.pull_request) {
                // GitHub answers a pull request number as an issue.
                continue;
            }
            const described = describeTask(item, payload);
            if (!described) {
                // It names the task but says nothing of it: watchers, dates, links.
                continue;
            }
            return {
                status: 'found',
                task: {
                    tracker: this.name,
                    id: taskId(reference),
                    ...described,
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

    private loadTools(): Promise<MCPToolRaw[]> {
        this.tools ??= this.session.tools();
        return this.tools;
    }
}

/** Never marked or named as writing. The bar for a tool the org picked itself. */
export function isReadOnly(tool: MCPToolRaw): boolean {
    const annotations = asRecord(tool.annotations);
    return (
        annotations.readOnlyHint !== false &&
        annotations.destructiveHint !== true &&
        !namesAWrite(tool.name)
    );
}

export function isSingleItemReader(tool: MCPToolRaw): boolean {
    if (
        !isReadOnly(tool) ||
        !TASK_NOUN.test(tool.name) ||
        !AFTER_TASK_NOUN.test(tool.name) ||
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
    repository?: { owner?: string; name: string },
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

    if (repository) {
        // `#12` lives in the PR's repository: fill where the server asks for it.
        for (const name of Object.keys(properties)) {
            if (name === id) {
                continue;
            }
            if (OWNER_PARAM.test(name) && repository.owner) {
                args[name] = repository.owner;
            } else if (REPO_PARAM.test(name)) {
                args[name] = repository.name;
            } else if (PROJECT_PATH_PARAM.test(name) && repository.owner) {
                args[name] = `${repository.owner}/${repository.name}`;
            }
        }
    }

    const missing = (schema.required ?? []).filter(
        (name) => args[name] === undefined,
    );
    return missing.length ? undefined : args;
}

function takesRepository(tool: MCPToolRaw): boolean {
    return Object.keys(asRecord(asRecord(tool.inputSchema).properties)).some(
        (name) =>
            OWNER_PARAM.test(name) ||
            REPO_PARAM.test(name) ||
            PROJECT_PATH_PARAM.test(name),
    );
}

/** The id a task is shown with: `AB#12`, `owner/repo#12`, `SAA-96`. */
export function taskId(reference: TaskReference): string {
    if (reference.kind === 'work_item') {
        return `AB#${reference.id}`;
    }
    if (reference.kind === 'git_issue') {
        return reference.repository
            ? `${reference.repository.owner}/${reference.repository.name}#${reference.id}`
            : `#${reference.id}`;
    }
    return reference.id;
}

function idParam(schema: Schema): string | undefined {
    return Object.keys(schema.properties ?? {}).find((name) =>
        ID_PARAM.test(name),
    );
}
