import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import { recordsIn, textField, toText } from './task-payload';
import { McpTaskTracker } from './tracker';

export const JIRA_TOOLS = ['getAccessibleAtlassianResources', 'getJiraIssue'];

/** Custom fields shorter than this are labels and ids, not requirements. */
const MIN_CUSTOM_FIELD_TEXT = 20;

/**
 * Jira through Atlassian's remote MCP (Rovo). An issue lives in one site
 * (`cloudId`); a key from a URL is looked up in that URL's site first.
 */
export class JiraTracker extends McpTaskTracker {
    readonly name = 'Jira';
    private sites?: Promise<Array<{ id: string; url?: string }>>;

    constructor(session: McpToolSession) {
        super(session);
    }

    canRead(reference: TaskReference): boolean {
        return (
            reference.kind === 'key' &&
            (reference.host === undefined || reference.host === 'jira')
        );
    }

    protected async lookup(reference: TaskReference): Promise<TrackerLookup> {
        const sites = await this.loadSites();
        const host =
            'url' in reference && reference.url
                ? safeHost(reference.url)
                : undefined;
        const ordered = host
            ? [
                  ...sites.filter((s) => s.url && safeHost(s.url) === host),
                  ...sites.filter((s) => !s.url || safeHost(s.url) !== host),
              ]
            : sites;

        for (const site of ordered.slice(0, 3)) {
            let payload: unknown;
            try {
                payload = await this.session.call('getJiraIssue', {
                    cloudId: site.id,
                    issueIdOrKey: reference.id,
                });
            } catch (error) {
                if (error instanceof TaskNotFoundError) {
                    continue;
                }
                throw error;
            }

            const issue = recordsIn(payload).find(
                (record) =>
                    typeof record.key === 'string' &&
                    record.key.toUpperCase() === reference.id,
            );
            if (!issue) {
                continue;
            }
            const fields = asRecord(issue.fields);
            return {
                status: 'found',
                task: {
                    tracker: this.name,
                    id: reference.id,
                    title: textField(fields, ['summary']),
                    description: joinSections([
                        textField(fields, ['description']),
                        customFieldText(fields),
                    ]),
                    url: site.url
                        ? `${site.url.replace(/\/$/, '')}/browse/${reference.id}`
                        : undefined,
                },
            };
        }
        return { status: 'not_found' };
    }

    private loadSites(): Promise<Array<{ id: string; url?: string }>> {
        this.sites ??= this.session
            .call('getAccessibleAtlassianResources', {})
            .then((payload) =>
                recordsIn(payload)
                    .filter(
                        (record) =>
                            typeof record.id === 'string' &&
                            (typeof record.url === 'string' ||
                                Array.isArray(record.scopes)),
                    )
                    .map((record) => ({
                        id: record.id as string,
                        url:
                            typeof record.url === 'string'
                                ? record.url
                                : undefined,
                    })),
            );
        return this.sites;
    }
}

/**
 * Teams keep acceptance criteria in custom fields whose names a read by id
 * does not return. Keep every long text field so the judge sees them.
 */
function customFieldText(fields: Record<string, unknown>): string | undefined {
    const texts = Object.entries(fields)
        .filter(([key]) => key.startsWith('customfield_'))
        .map(([, value]) => toText(value))
        .filter(
            (text): text is string =>
                typeof text === 'string' &&
                text.length >= MIN_CUSTOM_FIELD_TEXT,
        );
    return texts.length ? `Other fields:\n${texts.join('\n\n')}` : undefined;
}

function joinSections(sections: Array<string | undefined>): string | undefined {
    const present = sections.filter(Boolean);
    return present.length ? present.join('\n\n') : undefined;
}

function safeHost(url: string): string | undefined {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}
