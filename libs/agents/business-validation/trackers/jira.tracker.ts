import type {
    TaskReference,
    TrackerLookup,
} from '../business-validation.types';
import { asRecord } from '../value-utils';
import { McpToolSession, TaskNotFoundError } from './mcp-tool-session';
import { jiraCustomFields, recordsIn, textField } from './task-payload';
import { McpTaskTracker } from './tracker';

/** `getVisibleJiraProjects` only tells a typo from a version number; issues are never listed. */
export const JIRA_TOOLS = [
    'getAccessibleAtlassianResources',
    'getJiraIssue',
    'getVisibleJiraProjects',
];

/**
 * Jira through Atlassian's remote MCP (Rovo). An issue lives in one site
 * (`cloudId`); a key from a URL is looked up in that URL's site first.
 */
export class JiraTracker extends McpTaskTracker {
    readonly name = 'Jira';
    private sites?: Promise<Array<{ id: string; url?: string }>>;
    private fullIssueArgs?: Promise<Record<string, unknown>>;

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
                    ...(await this.loadFullIssueArgs()),
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
            const custom = jiraCustomFields(fields, asRecord(issue.names));
            const named = custom.named;
            const attachments = fields.attachment;
            return {
                status: 'found',
                task: {
                    tracker: this.name,
                    id: reference.id,
                    title: textField(fields, ['summary']),
                    description:
                        [textField(fields, ['description']), custom.text]
                            .filter(Boolean)
                            .join('\n\n') || undefined,
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

    /**
     * Without `fields`, Rovo answers a compact set of system fields: the
     * custom fields where teams keep acceptance criteria never arrive. Sent
     * only when the tool declares them, since an unknown argument fails.
     */
    private loadFullIssueArgs(): Promise<Record<string, unknown>> {
        this.fullIssueArgs ??= this.session.tools().then((tools) => {
            const properties = asRecord(
                asRecord(
                    tools.find((t) => t.name === 'getJiraIssue')?.inputSchema,
                ).properties,
            );
            return {
                ...('fields' in properties ? { fields: ['*all'] } : {}),
                ...('expand' in properties ? { expand: 'names' } : {}),
            };
        });
        return this.fullIssueArgs;
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

function safeHost(url: string): string | undefined {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}
