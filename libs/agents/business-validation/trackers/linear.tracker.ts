import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { asRecord, isEmpty } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import type { RelatedTask, Task } from '../business-validation.types';
import {
    linksIn,
    MAX_SUBTASKS,
    mentions,
    recordsIn,
    relatedTask,
    textField,
} from './task-payload';
import { McpTaskTracker } from './tracker';

/**
 * `get_team` and `list_teams` only tell a typo (`SAA-999`) from a version
 * number (`UTF-8`). `list_issues` lists one issue's sub-issues, never a
 * search for the task; `get_document` reads a doc attached to it.
 */
export const LINEAR_TOOLS = [
    'get_issue',
    'get_team',
    'list_teams',
    'list_issues',
    'get_document',
];

/** The most teams one `list_teams` call returns. */
const TEAMS_PAGE = 250;

/** Linear's remote MCP (`mcp.linear.app`). Reads one issue by its identifier. */
export class LinearTracker extends McpTaskTracker {
    readonly name = 'Linear';
    private tools?: Promise<MCPToolRaw[]>;
    private teams = new Map<string, Promise<boolean>>();

    constructor(session: McpToolSession) {
        super(session);
    }

    canRead(reference: TaskReference): boolean {
        return (
            reference.kind === 'key' &&
            (reference.host === undefined || reference.host === 'linear')
        );
    }

    protected async lookup(reference: TaskReference): Promise<TrackerLookup> {
        const payload = await this.session.call('get_issue', {
            id: reference.id,
        });

        // The identifier (`SAA-96`) is `identifier` in older answers and
        // `id` in current ones, where the internal id moved to `uuid`. A
        // parent is named by that internal id, so it matches too.
        const wanted = reference.id.toUpperCase();
        const issue = recordsIn(payload).find((record) =>
            [record.identifier, record.id, record.uuid].some(
                (key) =>
                    typeof key === 'string' && key.toUpperCase() === wanted,
            ),
        );
        if (issue) {
            return {
                status: 'found',
                // No `description` key at all is a shape miss (the answer
                // moved again, #1810), not an issue with no description: an
                // empty one stays thin.
                ...(!('description' in issue) ? { incomplete: true } : {}),
                task: {
                    tracker: this.name,
                    id: identifierOf(issue) ?? reference.id,
                    title: textField(issue, ['title']),
                    description: textField(issue, ['description']),
                    url: textField(issue, ['url']),
                    updatedAt:
                        typeof issue.updatedAt === 'string'
                            ? issue.updatedAt
                            : undefined,
                    hasAttachments:
                        Array.isArray(issue.attachments) &&
                        issue.attachments.length > 0,
                    links: linksIn(issue),
                },
            };
        }

        // The server may answer in markdown instead of JSON. Accept it only
        // when it names the issue that was asked for.
        if (typeof payload === 'string' && mentions(payload, reference.id)) {
            return {
                status: 'found',
                task: {
                    tracker: this.name,
                    id: reference.id,
                    description: payload,
                },
            };
        }
        // It answered without an error and without the issue: a shape this
        // tracker can't read, so the finder may look.
        return isEmpty(payload)
            ? { status: 'not_found' }
            : { status: 'not_found', unread: true };
    }

    /**
     * Asks for the one team when the server has `get_team`: listing them
     * returns a page, and a large workspace's team may not be on it.
     */
    async ownsReference(
        reference: TaskReference,
    ): Promise<boolean | undefined> {
        if (reference.kind !== 'key') {
            return false;
        }
        const prefix = reference.id.split('-')[0];
        const getTeam = (await this.loadTools()).find(
            (t) => t.name === 'get_team',
        );
        const param = getTeam && teamParam(getTeam);
        if (!param) {
            return super.ownsReference(reference);
        }
        if (!this.teams.has(prefix)) {
            this.teams.set(
                prefix,
                this.session
                    .call('get_team', { [param]: prefix })
                    .then((payload) =>
                        recordsIn(payload).some(
                            (r) =>
                                typeof r.key === 'string' &&
                                r.key.toUpperCase() === prefix,
                        ),
                    )
                    .catch((error) => {
                        if (error instanceof TaskNotFoundError) {
                            return false;
                        }
                        return super.ownsReference(reference);
                    }),
            );
        }
        return this.teams.get(prefix)!;
    }

    /**
     * `get_issue` names the parent, not the sub-issues: they are listed by
     * parent. Not when `list_issues` declares its arguments without
     * `parentId`: the filter would be dropped and the answer would be a page
     * of unrelated issues.
     */
    protected async childrenOf(task: Task): Promise<RelatedTask[]> {
        const declared = Object.keys(
            asRecord(
                asRecord(
                    (await this.loadTools()).find(
                        (t) => t.name === 'list_issues',
                    )?.inputSchema,
                ).properties,
            ),
        );
        if (declared.length && !declared.includes('parentId')) {
            return [];
        }
        const payload = await this.session.call('list_issues', {
            parentId: task.id,
            ...(!declared.length || declared.includes('limit')
                ? { limit: MAX_SUBTASKS }
                : {}),
        });
        // Issues only, never their nested team, state or assignee.
        return recordsIn(payload)
            .filter((record) => identifierOf(record) !== undefined)
            .map((record) => relatedTask(record))
            .filter(
                (child): child is RelatedTask =>
                    !!child && child.id.toUpperCase() !== task.id,
            )
            .slice(0, MAX_SUBTASKS);
    }

    protected async documentText(id: string): Promise<string | undefined> {
        const payload = await this.session.call('get_document', { id });
        const doc = recordsIn(payload).find((record) => record.id === id);
        return doc ? textField(doc, ['content']) : undefined;
    }

    private loadTools(): Promise<MCPToolRaw[]> {
        this.tools ??= this.session.tools().catch(() => []);
        return this.tools;
    }

    protected async projectKeys(): Promise<string[]> {
        const declared = asRecord(
            asRecord(
                (await this.loadTools()).find((t) => t.name === 'list_teams')
                    ?.inputSchema,
            ).properties,
        );
        const payload = await this.session.call(
            'list_teams',
            'limit' in declared ? { limit: TEAMS_PAGE } : {},
        );
        const keys = recordsIn(payload, 6, TEAMS_PAGE)
            .map((record) => record.key)
            .filter((key): key is string => typeof key === 'string');
        if (keys.length || typeof payload !== 'string') {
            return keys;
        }
        // Markdown answer: keys appear as `Key: SAA` or `(SAA)`.
        return [
            ...payload.matchAll(/(?:\bkey\W+|\()([A-Z][A-Z0-9]{1,9})\b/gi),
        ].map((m) => m[1].toUpperCase());
    }
}

/** The issue's `SAA-96`, whichever field holds it. */
function identifierOf(record: Record<string, unknown>): string | undefined {
    const key = [record.identifier, record.id].find(
        (value): value is string =>
            typeof value === 'string' && /^[A-Z][A-Z0-9_]*-\d+$/i.test(value),
    );
    return key?.toUpperCase();
}

function teamParam(tool: MCPToolRaw): string | undefined {
    const properties = Object.keys(
        asRecord(asRecord(tool.inputSchema).properties),
    );
    return ['query', 'key', 'id'].find((name) => properties.includes(name));
}
