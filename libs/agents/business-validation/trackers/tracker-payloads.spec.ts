import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { extractTaskReferences } from '../task-references';
import { CustomMcpTracker } from './custom-mcp.tracker';
import { JiraTracker } from './jira.tracker';
import { LinearTracker } from './linear.tracker';
import { TaskNotFoundError, type McpToolSession } from './mcp-tool-session';
import { NotionTracker } from './notion.tracker';

/**
 * What each tracker's MCP answers, in the shape its documentation gives, and
 * what Kody reads from it. The domain is invented.
 */

const tool = (
    name: string,
    properties: Record<string, any> = {},
    required: string[] = [],
): MCPToolRaw =>
    ({
        name,
        description: name,
        inputSchema: { type: 'object', properties, required },
    }) as MCPToolRaw;

function session(handlers: {
    tools?: MCPToolRaw[];
    call?: (name: string, args: Record<string, unknown>) => unknown;
}): McpToolSession & { calls: Array<[string, Record<string, unknown>]> } {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const called: string[] = [];
    return {
        calls,
        called,
        tools: async () => handlers.tools ?? [],
        call: async (name: string, args: Record<string, unknown>) => {
            calls.push([name, args]);
            called.push(name);
            return handlers.call?.(name, args);
        },
        close: async () => undefined,
    } as any;
}

const ref = (text: string) => extractTaskReferences({ command: text })[0];
const context = { organizationAndTeamData: {} as any };

describe('Linear (get_issue)', () => {
    it('reads the JSON the server answers', async () => {
        const s = session({
            call: () => ({
                id: '2f1c0b6e-0000-4000-8000-000000000001',
                identifier: 'SAA-96',
                title: 'Sticky notes',
                description: '## Acceptance criteria\n- Drag to reorder',
                url: 'https://linear.app/acme/issue/SAA-96/sticky-notes',
                status: 'In Progress',
                attachments: [],
            }),
        });
        const lookup = await new LinearTracker(s).read(ref('SAA-96'), context);
        expect(lookup).toMatchObject({
            status: 'found',
            task: {
                title: 'Sticky notes',
                description: expect.stringContaining('Drag to reorder'),
            },
        });
        expect(s.calls).toEqual([['get_issue', { id: 'SAA-96' }]]);
    });

    it('reads the current answer, where `id` is the identifier and `uuid` the internal id', async () => {
        const s = session({
            call: () => ({
                id: 'SAA-96',
                uuid: '2f1c0b6e-0000-4000-8000-000000000001',
                title: 'Sticky notes',
                description: '## Acceptance criteria\n- Drag to reorder',
                priority: { value: 0, name: 'No priority' },
                url: 'https://linear.app/acme/issue/SAA-96/sticky-notes',
            }),
        });
        const lookup = await new LinearTracker(s).read(
            ref('feat/saa-96-sticky-notes'),
            context,
        );
        expect(lookup).toMatchObject({
            status: 'found',
            task: {
                id: 'SAA-96',
                title: 'Sticky notes',
                url: 'https://linear.app/acme/issue/SAA-96/sticky-notes',
            },
        });
    });
});

describe('Jira through Rovo (getJiraIssue)', () => {
    const site = [
        {
            id: 'c0ffee00-0000-4000-8000-000000000001',
            url: 'https://acme.atlassian.net',
            scopes: ['read:jira-work'],
        },
    ];
    const getJiraIssue = tool(
        'getJiraIssue',
        {
            cloudId: { type: 'string' },
            issueIdOrKey: { type: 'string' },
            fields: { type: 'array', items: { type: 'string' } },
            expand: { type: 'string' },
        },
        ['cloudId', 'issueIdOrKey'],
    );

    it('asks for every field, since criteria often live in a custom one', async () => {
        const s = session({
            tools: [getJiraIssue],
            call: (name, args) =>
                name === 'getAccessibleAtlassianResources'
                    ? site
                    : {
                          key: 'SHOP-12',
                          fields: {
                              summary: 'Gift cards at checkout',
                              description: 'Let buyers pay with a gift card.',
                              ...(args.fields
                                  ? {
                                        customfield_10031:
                                            'Given a card with balance, the order total drops by it',
                                    }
                                  : {}),
                          },
                          ...(args.expand
                              ? {
                                    names: {
                                        customfield_10031:
                                            'Acceptance Criteria',
                                    },
                                }
                              : {}),
                      },
        });

        const lookup = await new JiraTracker(s).read(ref('SHOP-12'), context);

        expect(
            s.calls.find(([name]) => name === 'getJiraIssue')?.[1],
        ).toMatchObject({
            fields: ['*all'],
            expand: 'names',
        });
        expect(lookup).toMatchObject({
            status: 'found',
            task: {
                description: expect.stringContaining('order total drops'),
                fields: { 'Acceptance Criteria': expect.any(String) },
            },
        });
    });

    it('sends no argument the tool does not declare', async () => {
        const s = session({
            tools: [tool('getJiraIssue', { cloudId: {}, issueIdOrKey: {} })],
            call: (name) =>
                name === 'getAccessibleAtlassianResources'
                    ? site
                    : { key: 'SHOP-12', fields: { summary: 'Gift cards' } },
        });
        await new JiraTracker(s).read(ref('SHOP-12'), context);
        expect(s.calls.find(([name]) => name === 'getJiraIssue')?.[1]).toEqual({
            cloudId: site[0].id,
            issueIdOrKey: 'SHOP-12',
        });
    });
});

describe('Notion (notion-fetch)', () => {
    const url =
        'https://www.notion.so/acme/Gift-cards-1a2b3c4d5e6f40718293a4b5c6d7e8f9';
    const page = {
        metadata: { type: 'page' },
        title: 'Gift cards at checkout',
        url,
        text: [
            `<page url="${url}">`,
            '<properties>',
            '{"Status":"In progress","Owner":"Nina"}',
            '</properties>',
            '<content>',
            '## Acceptance criteria',
            '- The order total drops by the card balance',
            '</content>',
            '</page>',
        ].join('\n'),
    };

    it('reads a page with the tool the server names notion-fetch', async () => {
        const s = session({
            tools: [
                tool('notion-search'),
                tool('notion-fetch', { id: { type: 'string' } }),
            ],
            call: (name) => (name === 'notion-fetch' ? page : undefined),
        });
        const lookup = await new NotionTracker(s).read(ref(url), context);
        expect(s.calls.map(([name]) => name)).toEqual(['notion-fetch']);
        expect(lookup).toMatchObject({
            status: 'found',
            task: {
                title: 'Gift cards at checkout',
                description: expect.stringContaining('order total drops'),
            },
        });
        const description = (lookup as any).task.description as string;
        expect(description).toContain('Status: In progress');
        expect(description).not.toContain('<content>');
    });

    it('still reads through fetch on servers that name it so', async () => {
        const s = session({
            tools: [tool('search'), tool('fetch', { id: { type: 'string' } })],
            call: (name) => (name === 'fetch' ? page : undefined),
        });
        const lookup = await new NotionTracker(s).read(ref(url), context);
        expect(lookup.status).toBe('found');
    });

    it('reads a page the integration cannot see as not found', async () => {
        const s = session({
            tools: [tool('notion-fetch', { id: {} })],
            call: () => {
                throw new TaskNotFoundError('object_not_found');
            },
        });
        const lookup = await new NotionTracker(s).read(ref(url), context);
        expect(lookup.status).toBe('not_found');
    });
});

describe('a custom Jira plugin (mcp-atlassian)', () => {
    const byKey = { issue_key: { type: 'string' } };

    it('reads the issue, not its watchers or dates', async () => {
        const s = session({
            tools: [
                tool('jira_get_issue_watchers', byKey, ['issue_key']),
                tool('jira_get_issue_dates', byKey, ['issue_key']),
                tool(
                    'jira_get_issue',
                    { ...byKey, fields: { type: 'string' } },
                    ['issue_key'],
                ),
            ],
            call: (name, args) =>
                name === 'jira_get_issue'
                    ? {
                          key: args.issue_key,
                          summary: 'Gift cards at checkout',
                          description: 'Let buyers pay with a gift card.',
                      }
                    : { issue_key: args.issue_key, watch_count: 2 },
        });
        const lookup = await new CustomMcpTracker('Jira', s).read(
            ref('SHOP-12'),
            context,
        );
        expect(s.calls.map(([name]) => name)).toEqual(['jira_get_issue']);
        expect(lookup).toMatchObject({
            status: 'found',
            task: { title: 'Gift cards at checkout' },
        });
    });

    it('never takes an answer with no title and no description as the task', async () => {
        const s = session({
            tools: [tool('get_issue', byKey, ['issue_key'])],
            call: (_name, args) => ({
                issue_key: args.issue_key,
                watch_count: 2,
            }),
        });
        const lookup = await new CustomMcpTracker('Jira', s).read(
            ref('SHOP-12'),
            context,
        );
        expect(lookup.status).toBe('not_found');
    });
});

describe('Azure DevOps as a custom plugin (wit_get_work_item)', () => {
    it('reads the description and the acceptance criteria, as text', async () => {
        const workItem = tool(
            'wit_get_work_item',
            { id: { type: 'number' }, project: { type: 'string' } },
            ['id', 'project'],
        );
        const s = session({ tools: [workItem] });
        const tracker = new CustomMcpTracker(
            'Azure DevOps',
            s,
            'wit_get_work_item',
            async ({ call }) =>
                call({ id: 8, project: 'Shop' }).then(() => ({
                    id: 8,
                    fields: {
                        'System.Title': 'Gift cards at checkout',
                        'System.Description':
                            '<div>Let buyers pay with a <b>gift card</b>.</div>',
                        'Microsoft.VSTS.Common.AcceptanceCriteria':
                            '<ul><li>The order total drops by the card balance</li></ul>',
                    },
                })),
        );

        const lookup = await tracker.read(ref('AB#8'), context);
        const description = (lookup as any).task?.description as string;

        expect(description).toContain('Let buyers pay with a gift card.');
        expect(description).toContain(
            'The order total drops by the card balance',
        );
        expect(description).not.toMatch(/<\/?(div|b|ul|li)>/);
    });
});

describe('Linear teams, to tell a typo from a version number', () => {
    it('asks for the one team when the server can (get_team)', async () => {
        const s = session({
            tools: [tool('get_team', { query: { type: 'string' } }, ['query'])],
            call: (_name, args) => {
                if (args.query === 'SAA') {
                    return { id: 't-1', key: 'SAA', name: 'Sticky' };
                }
                throw new TaskNotFoundError(`Team ${args.query} not found`);
            },
        });
        const linear = new LinearTracker(s);
        expect(await linear.ownsReference(ref('SAA-999'))).toBe(true);
        expect(await linear.ownsReference(ref('UTF-8'))).toBe(false);
        expect(s.calls).toEqual([
            ['get_team', { query: 'SAA' }],
            ['get_team', { query: 'UTF' }],
        ]);
    });

    it('sees every team of a large workspace when it has to list them', async () => {
        const teams = Array.from({ length: 120 }, (_, i) => ({
            id: `t-${i}`,
            key: `T${i}`,
            name: `Team ${i}`,
        }));
        const s = session({
            tools: [tool('list_teams', { limit: { type: 'number' } })],
            call: (_name, args) => ({
                teams: teams.slice(0, Number(args.limit ?? 50)),
            }),
        });
        expect(await new LinearTracker(s).ownsReference(ref('T110-4'))).toBe(
            true,
        );
        expect(s.calls).toEqual([['list_teams', { limit: 250 }]]);
    });
});

describe('the repository host as a custom plugin, chosen as the task source', () => {
    const repository = { owner: 'acme', name: 'shop' };
    const inRepo = { ...context, repository };

    it('reads #12 with the official GitHub server (issue_read)', async () => {
        const s = session({
            tools: [
                tool(
                    'issue_read',
                    {
                        method: {
                            type: 'string',
                            enum: ['get', 'get_comments', 'get_labels'],
                        },
                        owner: { type: 'string' },
                        repo: { type: 'string' },
                        issue_number: { type: 'number' },
                    },
                    ['method', 'owner', 'repo', 'issue_number'],
                ),
            ],
            call: () => ({
                id: 2900000012,
                number: 12,
                title: 'Gift cards at checkout',
                body: 'Let buyers pay with a gift card.',
                html_url: 'https://github.com/acme/shop/issues/12',
                state: 'open',
            }),
        });
        const tracker = new CustomMcpTracker(
            'GitHub',
            s,
            'issue_read',
            undefined,
            true,
        );

        const lookup = await tracker.read(ref('#12'), inRepo);

        expect(s.calls).toEqual([
            [
                'issue_read',
                {
                    method: 'get',
                    owner: 'acme',
                    repo: 'shop',
                    issue_number: 12,
                },
            ],
        ]);
        expect(lookup).toMatchObject({
            status: 'found',
            task: {
                id: '#12',
                title: 'Gift cards at checkout',
                url: 'https://github.com/acme/shop/issues/12',
            },
        });
    });

    it('never reads a pull request number as the task', async () => {
        const s = session({
            tools: [
                tool('issue_read', {
                    owner: {},
                    repo: {},
                    issue_number: { type: 'number' },
                }),
            ],
            call: () => ({
                number: 12,
                title: 'Add gift cards',
                body: 'Implements it',
                pull_request: {
                    url: 'https://api.github.com/repos/acme/shop/pulls/12',
                },
            }),
        });
        const tracker = new CustomMcpTracker(
            'GitHub',
            s,
            'issue_read',
            undefined,
            true,
        );
        expect((await tracker.read(ref('#12'), inRepo)).status).toBe(
            'not_found',
        );
    });

    it('reads #12 with a GitLab server, by project path and iid', async () => {
        const s = session({
            tools: [
                tool(
                    'get_issue',
                    {
                        project_id: { type: 'string' },
                        issue_iid: { type: 'number' },
                    },
                    ['project_id', 'issue_iid'],
                ),
            ],
            call: () => ({
                id: 99001,
                iid: 12,
                title: 'Gift cards at checkout',
                description: 'Let buyers pay with a gift card.',
                web_url: 'https://gitlab.com/acme/shop/-/issues/12',
            }),
        });
        const lookup = await new CustomMcpTracker(
            'GitLab',
            s,
            undefined,
            undefined,
            true,
        ).read(ref('#12'), inRepo);
        expect(s.calls).toEqual([
            ['get_issue', { project_id: 'acme/shop', issue_iid: 12 }],
        ]);
        expect(lookup).toMatchObject({ status: 'found', task: { id: '#12' } });
    });

    it('never sends #12 to a tool that does not take the repository', async () => {
        // Jira reads `12` as an internal issue id: an unrelated issue.
        const s = session({
            tools: [
                tool('jira_get_issue', { issue_key: { type: 'string' } }, [
                    'issue_key',
                ]),
            ],
            call: () => ({
                key: 'SHOP-3',
                summary: 'Unrelated',
                description: '12',
            }),
        });
        const tracker = new CustomMcpTracker(
            'Jira',
            s,
            undefined,
            undefined,
            true,
        );
        expect((await tracker.read(ref('#12'), inRepo)).status).toBe(
            'not_found',
        );
        expect(s.calls).toEqual([]);
    });

    it('leaves #12 to Git Issues while the plugin was not chosen', () => {
        const tracker = new CustomMcpTracker('GitHub', session({}));
        expect(tracker.canRead(ref('#12'))).toBe(false);
    });
});

describe('ClickUp as a custom plugin (get_task)', () => {
    it('reads a task by its custom id, with its plain-text description', async () => {
        const s = session({
            tools: [
                tool('get_task', { task_id: { type: 'string' } }, ['task_id']),
            ],
            call: () => ({
                id: '86a1b2c3d',
                custom_id: 'DEV-12',
                name: 'Gift cards at checkout',
                text_content: 'Let buyers pay with a gift card.',
                url: 'https://app.clickup.com/t/86a1b2c3d',
            }),
        });
        const lookup = await new CustomMcpTracker('ClickUp', s).read(
            ref('DEV-12'),
            context,
        );
        expect(lookup).toMatchObject({
            status: 'found',
            task: {
                title: 'Gift cards at checkout',
                description: 'Let buyers pay with a gift card.',
                url: 'https://app.clickup.com/t/86a1b2c3d',
            },
        });
    });
});

describe('Shortcut as a custom plugin, with the team id pattern', () => {
    it('reads sc-123 through the tool the org picked, by its number', async () => {
        const [reference] = extractTaskReferences(
            { branch: 'nina/sc-123-gift-cards' },
            { taskIdPattern: 'sc-(\\d+)' },
        );
        const s = session({
            tools: [
                tool(
                    'stories-get-by-id',
                    { storyPublicId: { type: 'number' } },
                    ['storyPublicId'],
                ),
            ],
            call: () => ({
                id: 123,
                name: 'Gift cards at checkout',
                description: 'Let buyers pay with a gift card.',
                app_url: 'https://app.shortcut.com/acme/story/123',
            }),
        });
        const lookup = await new CustomMcpTracker(
            'Shortcut',
            s,
            'stories-get-by-id',
        ).read(reference, context);
        expect(s.calls).toEqual([
            ['stories-get-by-id', { storyPublicId: 123 }],
        ]);
        expect(lookup).toMatchObject({
            status: 'found',
            task: { title: 'Gift cards at checkout' },
        });
    });

    it('calls nothing when the picked tool is gone, and says the setup is wrong', async () => {
        const [reference] = extractTaskReferences(
            { branch: 'nina/sc-123-gift-cards' },
            { taskIdPattern: 'sc-(\\d+)' },
        );
        const s = session({
            tools: [tool('search-stories', { query: { type: 'string' } })],
            call: () => ({ id: 123, name: 'Gift cards at checkout' }),
        });
        const lookup = await new CustomMcpTracker(
            'Shortcut',
            s,
            'stories-get-by-id',
        ).read(reference, context);
        expect(s.calls).toEqual([]);
        expect(lookup).toMatchObject({ status: 'error', setup: true });
    });

    it('reads a server that listed no tools as down, not as set up wrong', async () => {
        const [reference] = extractTaskReferences(
            { branch: 'nina/sc-123-gift-cards' },
            { taskIdPattern: 'sc-(\\d+)' },
        );
        const lookup = await new CustomMcpTracker(
            'Shortcut',
            session({ tools: [] }),
            'stories-get-by-id',
        ).read(reference, context);
        expect(lookup.status).toBe('error');
        expect(lookup).not.toHaveProperty('setup');
    });
});
