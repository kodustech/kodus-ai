import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { McpToolSession } from './mcp-tool-session';
import { recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

export const NOTION_TOOLS = ['fetch'];

/** Notion's remote MCP. A task is a page, referenced only by its URL. */
export class NotionTracker extends McpTaskTracker {
    readonly name = 'Notion';

    constructor(session: McpToolSession) {
        super(session);
    }

    canRead(reference: TaskReference): boolean {
        return reference.kind === 'page';
    }

    protected async lookup(reference: TaskReference): Promise<TrackerLookup> {
        if (reference.kind !== 'page') {
            return { status: 'not_found' };
        }
        const payload = await this.session.call('fetch', { id: reference.url });

        if (typeof payload === 'string') {
            return payload.trim()
                ? {
                      status: 'found',
                      task: {
                          tracker: this.name,
                          id: reference.id,
                          description: payload,
                          url: reference.url,
                      },
                  }
                : { status: 'not_found' };
        }

        const page = recordsIn(payload)[0];
        const description = page
            ? textField(page, ['text', 'markdown', 'content', 'body'])
            : undefined;
        if (!page || !description) {
            return { status: 'not_found' };
        }
        return {
            status: 'found',
            task: {
                tracker: this.name,
                id: reference.id,
                title: textField(page, ['title', 'name']),
                description,
                url: reference.url,
            },
        };
    }
}
