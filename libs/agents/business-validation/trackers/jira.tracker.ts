import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import { recordsIn, textField, toText } from './task-payload';
import { McpTaskTracker } from './tracker';

/** `getVisibleJiraProjects` only tells a typo from a version number; issues are never listed. */
export const JIRA_TOOLS = [
    'getAccessibleAtlassianResources',
    'getJiraIssue',
    'getVisibleJiraProjects',
];

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
            const named = longFields(fields, asRecord(issue.names));
            const attachments = fields.attachment;
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
                    updatedAt:
                        typeof fields.updated === 'string'
                            ? fields.updated
                            : undefined,
                    hasAttachments:
                        Array.isArray(attachments) && attachments.length > 0,
                    ...(Object.keys(named).length ? { fields: named } : {}),
                },
            };
        }
        return { status: 'not_found' };
    }

    protected async projectKeys(): Promise<string[]> {
        const keys: string[] = [];
        for (const site of (await this.loadSites()).slice(0, 3)) {
            const payload = await this.session.call('getVisibleJiraProjects', {
                cloudId: site.id,
            });
            for (const record of recordsIn(payload)) {
                if (typeof record.key === 'string') {
                    keys.push(record.key);
                }
            }
        }
        return keys;
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

/**
 * Long text fields by id and, when the payload names them, by name too, so a
 * team can say "criteria live in Acceptance Criteria" or `customfield_10031`.
 */
function longFields(
    fields: Record<string, unknown>,
    names: Record<string, unknown>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (!key.startsWith('customfield_')) {
            continue;
        }
        const text = toText(value);
        if (typeof text !== 'string' || text.length < MIN_CUSTOM_FIELD_TEXT) {
            continue;
        }
        out[key] = text;
        if (typeof names[key] === 'string') {
            out[names[key] as string] = text;
        }
    }
    return out;
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
