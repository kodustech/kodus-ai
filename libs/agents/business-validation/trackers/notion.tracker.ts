import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession } from './mcp-tool-session';
import { recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

/** Notion's hosted MCP names it `notion-fetch`; OpenAI-style servers name it `fetch`. */
export const NOTION_TOOLS = ['notion-fetch', 'fetch'];

/** Notion's remote MCP. A task is a page, referenced only by its URL. */
export class NotionTracker extends McpTaskTracker {
    readonly name = 'Notion';
    private fetchTool?: Promise<string>;

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
        const payload = await this.session.call(await this.loadFetchTool(), {
            id: reference.url,
        });

        const page = typeof payload === 'string' ? {} : recordsIn(payload)[0];
        const text =
            typeof payload === 'string'
                ? payload
                : page
                  ? textField(page, ['text', 'markdown', 'content', 'body'])
                  : undefined;
        const description = text ? pageText(text) : undefined;
        const fields = text ? pageProperties(text) : {};
        if (!description) {
            return { status: 'not_found' };
        }
        return {
            status: 'found',
            task: {
                tracker: this.name,
                id: reference.id,
                title: page ? textField(page, ['title', 'name']) : undefined,
                description,
                url: reference.url,
                // A team may keep the criteria in a property: "criteria live
                // in Acceptance criteria" reads it by name.
                ...(Object.keys(fields).length ? { fields } : {}),
            },
        };
    }

    private loadFetchTool(): Promise<string> {
        this.fetchTool ??= this.session
            .tools()
            .then(
                (tools) =>
                    NOTION_TOOLS.find((name) =>
                        tools.some((t) => t.name === name),
                    ) ?? NOTION_TOOLS[0],
            );
        return this.fetchTool;
    }
}

/**
 * A fetched page is `<page><properties>{json}</properties><content>md</content></page>`:
 * the properties as `Name: value` lines, then the content.
 */
function pageText(text: string): string | undefined {
    const content = /<content>([\s\S]*?)<\/content>/.exec(text)?.[1];
    if (content === undefined) {
        return text.trim() || undefined;
    }
    const properties = /<properties>([\s\S]*?)<\/properties>/.exec(text)?.[1];
    const lines = Object.entries(asRecord(parseJson(properties)))
        .filter(
            ([, value]) =>
                typeof value === 'string' || typeof value === 'number',
        )
        .map(([name, value]) => `${name}: ${value}`);
    return (
        [lines.join('\n'), content.trim()].filter(Boolean).join('\n\n') ||
        undefined
    );
}

/** The page's text properties, by name. */
function pageProperties(text: string): Record<string, string> {
    const properties = /<properties>([\s\S]*?)<\/properties>/.exec(text)?.[1];
    return Object.fromEntries(
        Object.entries(asRecord(parseJson(properties))).filter(
            (entry): entry is [string, string] =>
                typeof entry[1] === 'string' && entry[1].trim() !== '',
        ),
    );
}

function parseJson(text?: string): unknown {
    try {
        return text ? JSON.parse(text) : undefined;
    } catch {
        return undefined;
    }
}
