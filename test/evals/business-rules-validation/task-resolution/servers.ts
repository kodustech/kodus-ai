/**
 * How each tracker's MCP server answers, reproduced for the fakes: the payload
 * a task comes back in, which arguments the server honors, and how it says a
 * task does not exist. Where a server was called live, the shape is the one it
 * returned (`live`); otherwise it is the one its documentation or source gives
 * (`docs`). Task content is always the fixture's invented domain.
 */
import type { TrackerFixture, TrackerTask } from './fixture.types';

type Shape = TrackerFixture['responseShape'];

export const SHAPE_SOURCE: Record<Shape, 'live' | 'docs'> = {
    linear: 'docs',
    linear_markdown: 'docs',
    // Rovo, called 2026-10-13: compact fields unless `fields` is sent,
    // `names` only with `expand`, description as markdown.
    jira: 'live',
    azure: 'docs',
    notion: 'docs',
    jira_community: 'docs',
    github_official: 'docs',
    gitlab: 'docs',
    clickup: 'docs',
    shortcut: 'docs',
};

/** The task's description as the team wrote it, criteria included where they keep them there. */
function descriptionOf(task: TrackerTask, format: 'markdown' | 'html'): string {
    const criteria = task.acceptanceCriteria ?? [];
    const at = task.criteriaAt ?? 'description';
    const heading =
        at === 'heading'
            ? (task.criteriaHeading ?? 'Definition of done')
            : at === 'description'
              ? 'Acceptance criteria'
              : undefined;
    const body = task.description ?? '';
    if (format === 'html') {
        return [
            body ? `<div>${body}</div>` : '',
            heading && criteria.length
                ? `<h2>${heading}</h2><ul>${criteria.map((c) => `<li>${c}</li>`).join('')}</ul>`
                : '',
        ].join('');
    }
    return heading && criteria.length
        ? `${body}\n\n## ${heading}\n${criteria.map((c) => `- ${c}`).join('\n')}`
        : body;
}

/** The criteria in their own field, as text or Atlassian Document Format. */
function fieldValue(task: TrackerTask): unknown {
    const criteria = task.acceptanceCriteria ?? [];
    if (task.fieldFormat === 'adf') {
        return {
            type: 'doc',
            version: 1,
            content: [
                {
                    type: 'bulletList',
                    content: criteria.map((c) => ({
                        type: 'listItem',
                        content: [
                            {
                                type: 'paragraph',
                                content: [{ type: 'text', text: c }],
                            },
                        ],
                    })),
                },
            ],
        };
    }
    return criteria.map((c) => `- ${c}`).join('\n');
}

const inField = (task: TrackerTask) =>
    task.criteriaAt === 'field' || task.criteriaAt === 'properties';

/** The task as the real server returns it for `args`. */
export function renderTask(
    tracker: TrackerFixture,
    task: TrackerTask,
    args: Record<string, unknown>,
): unknown {
    switch (tracker.responseShape) {
        case 'linear_markdown':
            return `# ${task.id}: ${task.title}\n\n${descriptionOf(task, 'markdown')}`;
        case 'linear':
            return {
                id: `uuid-${task.id}`,
                identifier: task.id,
                title: task.title,
                description: descriptionOf(task, 'markdown'),
                url: `https://linear.app/acme/issue/${task.id.toLowerCase()}`,
                status: 'Todo',
                attachments: [],
            };
        case 'jira': {
            const requested = Array.isArray(args.fields)
                ? (args.fields as string[])
                : [];
            const all = requested.includes('*all');
            const fields: Record<string, unknown> = {
                summary: task.title,
                description: descriptionOf(task, 'markdown'),
                status: { name: 'To Do' },
                issuetype: { name: 'Story' },
                updated: '2026-10-01T12:00:00.000-0300',
            };
            if (all || (task.field && requested.includes(task.field.id))) {
                if (task.field && inField(task)) {
                    fields[task.field.id] = fieldValue(task);
                }
                // Many empty or short custom fields come along, as on a real site.
                fields.customfield_10000 = null;
                fields.customfield_10019 = '0|i0001:';
                fields.attachment = Array.from(
                    { length: task.attachments ?? 0 },
                    (_, i) => ({ id: `att-${i}`, filename: `spec-${i}.pdf` }),
                );
            }
            const names =
                typeof args.expand === 'string' && args.expand.includes('names')
                    ? Object.fromEntries([
                          ['summary', 'Summary'],
                          ['description', 'Description'],
                          ...(task.field
                              ? [[task.field.id, task.field.name]]
                              : []),
                      ])
                    : undefined;
            return {
                expand: 'renderedFields,names,schema',
                id: `100${task.id.replace(/\D/g, '')}`,
                self: `https://api.atlassian.com/ex/jira/cloud/rest/api/3/issue/${task.id}`,
                key: task.id,
                ...(names ? { names } : {}),
                fields,
            };
        }
        case 'jira_community':
            // mcp-atlassian: a flattened issue.
            return {
                id: `100${task.id.replace(/\D/g, '')}`,
                key: task.id,
                summary: task.title,
                description: descriptionOf(task, 'markdown'),
                status: { name: 'To Do' },
            };
        case 'azure':
            return {
                id: Number(task.id),
                rev: 3,
                fields: {
                    'System.Title': task.title,
                    'System.Description': descriptionOf(task, 'html'),
                    'System.WorkItemType': 'User Story',
                    'System.State': 'Active',
                    ...(inField(task)
                        ? {
                              'Microsoft.VSTS.Common.AcceptanceCriteria': `<ul>${(
                                  task.acceptanceCriteria ?? []
                              )
                                  .map((c) => `<li>${c}</li>`)
                                  .join('')}</ul>`,
                          }
                        : {}),
                },
            };
        case 'notion': {
            const url = `https://www.notion.so/acme/${task.title.replace(/\W+/g, '-')}-${task.id}`;
            const properties: Record<string, string> = {
                Status: 'In progress',
                ...(inField(task) && task.field
                    ? {
                          [task.field.name]: (
                              task.acceptanceCriteria ?? []
                          ).join('\n'),
                      }
                    : {}),
            };
            return {
                metadata: { type: 'page' },
                title: task.title,
                url,
                text: [
                    `<page url="${url}">`,
                    '<properties>',
                    JSON.stringify(properties),
                    '</properties>',
                    '<content>',
                    descriptionOf(task, 'markdown'),
                    '</content>',
                    '</page>',
                ].join('\n'),
            };
        }
        case 'github_official':
            return {
                id: 2900000000 + Number(task.id),
                number: Number(task.id),
                title: task.title,
                body: descriptionOf(task, 'markdown'),
                state: 'open',
                html_url: `https://github.com/acme/recipes-web/issues/${task.id}`,
            };
        case 'gitlab':
            return {
                id: 99000 + Number(task.id),
                iid: Number(task.id),
                title: task.title,
                description: descriptionOf(task, 'markdown'),
                state: 'opened',
                web_url: `https://gitlab.com/acme/recipes-web/-/issues/${task.id}`,
            };
        case 'clickup':
            return {
                id: `86a${task.id.replace(/\W/g, '').toLowerCase()}`,
                custom_id: task.id,
                name: task.title,
                text_content: descriptionOf(task, 'markdown'),
                url: `https://app.clickup.com/t/86a${task.id.toLowerCase()}`,
                status: { status: 'to do' },
                custom_fields:
                    inField(task) && task.field
                        ? [
                              {
                                  id: task.field.id,
                                  name: task.field.name,
                                  type: 'text',
                                  value: (task.acceptanceCriteria ?? []).join(
                                      '\n',
                                  ),
                              },
                          ]
                        : [],
            };
        case 'shortcut':
            return {
                id: Number(task.id),
                name: task.title,
                description: descriptionOf(task, 'markdown'),
                app_url: `https://app.shortcut.com/acme/story/${task.id}`,
                story_type: 'feature',
            };
    }
}

/** Whether `requested`, as the tool was called, names `task`. */
export function sameTask(
    tracker: TrackerFixture,
    task: TrackerTask,
    requested: string,
): boolean {
    if (!requested) {
        return false;
    }
    switch (tracker.responseShape) {
        case 'azure':
        case 'shortcut':
        case 'github_official':
        case 'gitlab':
            return String(Number(requested)) === task.id;
        case 'notion':
            // Notion's fetch takes the page URL or its id.
            return requested.replace(/-/g, '').toLowerCase().endsWith(task.id);
        case 'clickup':
            return (
                requested.toLowerCase() === task.id.toLowerCase() ||
                requested === `86a${task.id.replace(/\W/g, '').toLowerCase()}`
            );
        default:
            return task.id.toLowerCase() === requested.toLowerCase();
    }
}

/** How the real server says the task is not there: always an error result. */
export function notFoundText(
    tracker: TrackerFixture,
    requested: string,
): string {
    switch (tracker.responseShape) {
        case 'jira':
            // In the token owner's language; only the status code is stable.
            return JSON.stringify({
                error: true,
                message: JSON.stringify({
                    errorMessages: [
                        'O item não existe ou você não tem permissão para vê-lo',
                    ],
                    errors: {},
                }),
                statusCode: 404,
            });
        case 'notion':
            return JSON.stringify({
                object: 'error',
                status: 404,
                code: 'object_not_found',
                message:
                    'Make sure the relevant pages and databases are shared with your integration.',
            });
        case 'linear':
        case 'linear_markdown':
            return 'Entity not found: Issue';
        case 'azure':
            return `TF401232: Work item ${requested} does not exist, or you do not have permissions to read it.`;
        case 'github_official':
            return `failed to get issue: GET https://api.github.com/repos/acme/recipes-web/issues/${requested}: 404 Not Found []`;
        case 'gitlab':
            return '{"message":"404 Not found"}';
        case 'clickup':
            return '{"err":"Task not found, deleted","ECODE":"ITEM_013"}';
        case 'shortcut':
            return `Failed to retrieve Shortcut story with public ID: ${requested}.`;
        case 'jira_community':
            return `Issue ${requested} not found.`;
    }
}
