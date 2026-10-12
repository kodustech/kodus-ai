import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { asRecord } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import { mentions, recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

/** `get_team` and `list_teams` only tell a typo (`SAA-999`) from a version number (`UTF-8`); tasks are never listed. */
export const LINEAR_TOOLS = ['get_issue', 'get_team', 'list_teams'];

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

        const issue = recordsIn(payload).find(
            (record) =>
                typeof record.identifier === 'string' &&
                record.identifier.toUpperCase() === reference.id,
        );
        if (issue) {
            return {
                status: 'found',
                task: {
                    tracker: this.name,
                    id: reference.id,
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
        return { status: 'not_found' };
    }

    /**
     * Asks for the one team when the server has `get_team`: listing them
     * returns a page, and a large workspace's team may not be on it.
     */
    async ownsReference(reference: TaskReference): Promise<boolean> {
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

function teamParam(tool: MCPToolRaw): string | undefined {
    const properties = Object.keys(
        asRecord(asRecord(tool.inputSchema).properties),
    );
    return ['query', 'key', 'id'].find((name) => properties.includes(name));
}
