import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { McpToolSession } from './mcp-tool-session';
import { mentions, recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

export const LINEAR_TOOLS = ['get_issue'];

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
}
