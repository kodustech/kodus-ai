import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { McpToolSession } from './mcp-tool-session';
import { mentions, recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

/** `list_teams` only tells a typo (`SAA-999`) from a version number (`UTF-8`); tasks are never listed. */
export const LINEAR_TOOLS = ['get_issue', 'list_teams'];

/** Linear's remote MCP (`mcp.linear.app`). Reads one issue by its identifier. */
export class LinearTracker extends McpTaskTracker {
    readonly name = 'Linear';

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

    protected async projectKeys(): Promise<string[]> {
        const payload = await this.session.call('list_teams', {});
        const keys = recordsIn(payload)
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
