import type { MCPServerConfig, MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { extractTaskReferences } from '../task-references';
import {
    CustomMcpTracker,
    isReadOnly,
    rankReadTools,
} from './custom-mcp.tracker';
import { GitIssuesTracker } from './git-issues.tracker';
import { LinearTracker } from './linear.tracker';
import {
    TrackerUnavailableError,
    type McpToolSession,
} from './mcp-tool-session';
import { buildTaskTrackers, isAutoTracker } from './tracker-catalog';

const server = (overrides: Partial<MCPServerConfig>): MCPServerConfig => ({
    name: 'x',
    type: 'http' as any,
    url: 'http://localhost',
    ...overrides,
});

const tool = (
    name: string,
    schema: Record<string, any> = {},
    annotations?: any,
): MCPToolRaw =>
    ({
        name,
        description: name,
        inputSchema: { type: 'object', ...schema },
        ...(annotations ? { annotations } : {}),
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

describe('buildTaskTrackers', () => {
    const servers = [
        server({ name: 'Linear', integrationId: 'linear-default' }),
        server({
            name: 'Azure DevOps',
            integrationId: 'azure-plugin',
            provider: 'custom',
        }),
        server({
            name: 'Billing',
            integrationId: 'billing',
            provider: 'custom',
        }),
    ];

    it('uses every tracker it recognizes when the source is auto', () => {
        // "Azure DevOps" names no tracker, so before a source is chosen it is not used.
        expect(buildTaskTrackers(servers).map((t) => t.name)).toEqual([
            'Linear',
        ]);
    });

    it('says which sources auto reads, as it builds them', () => {
        const clickUp = server({
            name: 'ClickUp',
            integrationId: 'clickup-plugin',
            provider: 'custom',
        });
        const all = [...servers, clickUp];
        expect(all.filter(isAutoTracker).map((s) => s.name)).toEqual(
            buildTaskTrackers(all).map((t) => t.name),
        );
        expect(isAutoTracker(clickUp)).toBe(true);
        expect(isAutoTracker(servers[2])).toBe(false);
    });

    it('uses only the chosen source, custom plugins included (#1884)', () => {
        expect(
            buildTaskTrackers(servers, {
                taskSource: 'azure-plugin',
                taskSourceTool: 'wit_work_item',
            }).map((t) => t.name),
        ).toEqual(['Azure DevOps']);
    });

    it('uses nothing when the chosen source is no longer connected', () => {
        expect(buildTaskTrackers(servers, { taskSource: 'gone' })).toEqual([]);
    });
});

describe('CustomMcpTracker with the tool the org picked', () => {
    const workItem = tool(
        'wit_work_item',
        {
            properties: {
                id: { type: 'number' },
                project: { type: 'string' },
            },
            required: ['id', 'project'],
        },
        { readOnlyHint: true },
    );

    it("asks an agent with only that tool when the schema alone can't fill the arguments", async () => {
        const s = session({ tools: [workItem] });
        const agentReader = jest.fn(async ({ call }) =>
            call({ id: 8, project: 'Tickets' }).then(() => ({
                id: 8,
                fields: {
                    'System.Title': 'Compact density toggle',
                    'System.Description': 'Adds a density switch',
                },
            })),
        );
        const tracker = new CustomMcpTracker(
            'Azure DevOps',
            s,
            'wit_work_item',
            agentReader,
        );

        const lookup = await tracker.read(ref('AB#8'), {
            organizationAndTeamData: {} as any,
        });

        expect(agentReader).toHaveBeenCalledTimes(1);
        expect(lookup).toMatchObject({
            status: 'found',
            task: { id: 'AB#8', title: 'Compact density toggle' },
        });
    });

    it("asks for the whole item when the agent reads through a summary tool (ClickUp's include)", async () => {
        const getTask = tool('clickup_get_task', {
            properties: {
                task_id: { type: 'string' },
                include: {
                    type: 'array',
                    items: { enum: ['description', 'checklists', 'watchers'] },
                },
            },
            required: ['task_id'],
        });
        const s = session({ tools: [getTask] });
        const agentReader = jest.fn(async ({ call }) =>
            call({ task_id: 'DEV-12' }).then(() => undefined),
        );
        await new CustomMcpTracker(
            'ClickUp',
            s,
            'clickup_get_task',
            agentReader,
        ).read(ref('DEV-12'), { organizationAndTeamData: {} as any });

        expect(s.calls.at(-1)).toEqual([
            'clickup_get_task',
            { task_id: 'DEV-12', include: ['description', 'checklists'] },
        ]);
    });

    it('never uses a picked tool that writes', async () => {
        const s = session({
            tools: [tool('update_work_item', { properties: { id: {} } })],
        });
        const tracker = new CustomMcpTracker(
            'Azure DevOps',
            s,
            'update_work_item',
        );
        const lookup = await tracker.read(ref('AB#8'), {
            organizationAndTeamData: {} as any,
        });
        expect(lookup.status).toBe('error');
        expect(s.calls).toEqual([]);
    });
});

describe('isReadOnly: a write verb is a word of the name, not part of one', () => {
    it('blocks tools named with a verb that writes, in any casing', () => {
        for (const name of [
            'save_issue',
            'createIssue',
            'DELETE_TASK',
            'issue.addComment',
            'deleteissue',
            'wit_update_work_item',
        ]) {
            expect([name, isReadOnly(tool(name))]).toEqual([name, false]);
        }
    });

    it('lets through readers whose words only contain a verb', () => {
        for (const name of [
            'get_markdown',
            'list_bookmarks',
            'find_duplicates',
            'get_shared_with_me',
            'list_installed_apps',
            'getIssueSettings',
        ]) {
            expect([name, isReadOnly(tool(name))]).toEqual([name, true]);
        }
    });

    it('takes an unmarked tool only when a read verb names it, and a marked one on its mark', () => {
        for (const name of [
            'complete_task',
            'start_task',
            'claim_task',
            'clone_issue',
            'unarchive_issue',
            'transfer_issue',
            'jira_issue',
        ]) {
            expect([name, isReadOnly(tool(name))]).toEqual([name, false]);
        }
        expect(isReadOnly(tool('jira_issue', {}, { readOnlyHint: true }))).toBe(
            true,
        );
    });
});

describe('rankReadTools (UC-04)', () => {
    it('offers read-by-id tools, best first, and never one that writes or lists', () => {
        const ranked = rankReadTools([
            tool('wit_create_work_item', { properties: { id: {} } }),
            tool('wit_list_backlogs', { properties: { id: {} } }),
            tool('search_workitem', { properties: { text: {} } }),
            tool('get_project', { properties: { id: {} } }),
            tool('wit_get_work_item', { properties: { id: {} } }),
            tool(
                'wit_work_item',
                { properties: { id: {} } },
                { readOnlyHint: false },
            ),
        ]);
        expect(ranked.map((t) => [t.name, t.recommended])).toEqual([
            ['wit_get_work_item', true],
            ['get_project', false],
        ]);
    });
});

describe('McpTaskTracker', () => {
    it('tries a tracker that failed once a second time before giving up', async () => {
        let calls = 0;
        const s = session({
            call: () => {
                calls += 1;
                if (calls === 1) throw new TrackerUnavailableError('timeout');
                return {
                    identifier: 'SAA-96',
                    title: 'Sticky notes',
                    description: 'Drag to reorder',
                };
            },
        });
        const lookup = await new LinearTracker(s).read(ref('SAA-96'), {
            organizationAndTeamData: {} as any,
        });
        expect(calls).toBe(2);
        expect(lookup.status).toBe('found');
    });

    it('says which tools it called to read a task, for the test on a PR', async () => {
        const s = session({
            call: () => ({
                identifier: 'SAA-96',
                title: 'Sticky notes',
                description: 'Drag to reorder',
            }),
        });
        const lookup = await new LinearTracker(s).read(ref('SAA-96'), {
            organizationAndTeamData: {} as any,
        });
        expect(lookup).toMatchObject({ status: 'found', tools: ['get_issue'] });
    });

    it('fails to tell, rather than says no, when the teams cannot be listed', async () => {
        const s = session({
            call: () => {
                throw new TrackerUnavailableError('timeout');
            },
        });
        await expect(
            new LinearTracker(s).ownsReference(ref('SAA-999')),
        ).rejects.toThrow('timeout');
    });

    it('cannot tell whose key it is without listing keys', async () => {
        expect(
            await new CustomMcpTracker('Acme', session({})).ownsReference(
                ref('SAA-999'),
            ),
        ).toBeUndefined();
    });

    it('knows SAA is a team in Linear and UTF is not (UC-14, UC-21)', async () => {
        const s = session({
            call: (name) =>
                name === 'list_teams'
                    ? [{ key: 'SAA', name: 'Sticky' }]
                    : undefined,
        });
        const linear = new LinearTracker(s);
        expect(await linear.ownsReference(ref('SAA-999'))).toBe(true);
        expect(await linear.ownsReference(ref('UTF-8'))).toBe(false);
        // Teams are listed once per validation.
        expect(s.calls.filter(([name]) => name === 'list_teams')).toHaveLength(
            1,
        );
    });
});

describe('McpTaskTracker.relate: what a found task links to', () => {
    const issues: Record<string, Record<string, unknown>> = {
        'KOD-20': {
            id: 'KOD-20',
            title: 'Bulk archive',
            description: 'Archive part of the parent issue.',
            parentId: 'KOD-19',
            documents: [],
        },
        'KOD-19': {
            id: 'KOD-19',
            title: 'Ticket list: bulk actions',
            description:
                '## Acceptance criteria\n- A checkbox selects the ticket\n- "Archive selected" archives every selected ticket',
        },
        'KOD-22': {
            id: 'KOD-22',
            title: 'Ticket export',
            description: 'Spec in the attached document.',
            documents: [{ id: 'doc-1', title: 'Export spec' }],
        },
    };
    const linear = () =>
        session({
            call: (name, args) => {
                if (name === 'get_issue') {
                    return issues[args.id as string];
                }
                if (name === 'list_issues') {
                    return args.parentId === 'KOD-19'
                        ? {
                              issues: [
                                  {
                                      id: 'KOD-20',
                                      title: 'Bulk archive',
                                      status: 'Todo',
                                  },
                                  { id: 'KOD-21', title: 'Row checkboxes' },
                              ],
                          }
                        : { issues: [] };
                }
                if (name === 'get_document') {
                    return {
                        id: 'doc-1',
                        content:
                            '## Acceptance criteria\n- Export downloads a CSV',
                    };
                }
            },
        });
    const context = { organizationAndTeamData: { organizationId: 'org-1' } };
    const found = async (s: ReturnType<typeof linear>, id: string) => {
        const tracker = new LinearTracker(s);
        const read = await tracker.read(ref(id), context);
        if (read.status !== 'found') {
            throw new Error(`${id} not found`);
        }
        return tracker.relate(read.task, context);
    };

    it("reads a sub-issue's parent whole, and never hands the raw links on", async () => {
        const task = await found(linear(), 'KOD-20');
        expect(task.parent).toMatchObject({
            id: 'KOD-19',
            title: 'Ticket list: bulk actions',
        });
        expect(task.parent?.description).toContain('Archive selected');
        expect(task.links).toBeUndefined();
    });

    it('lists the sub-issues of a parent by title and status', async () => {
        const task = await found(linear(), 'KOD-19');
        expect(task.subtasks).toEqual([
            { id: 'KOD-20', title: 'Bulk archive', status: 'Todo' },
            { id: 'KOD-21', title: 'Row checkboxes', status: undefined },
        ]);
    });

    it('folds an attached document into the description', async () => {
        const task = await found(linear(), 'KOD-22');
        expect(task.description).toContain('## Document: Export spec');
        expect(task.description).toContain('Export downloads a CSV');
    });

    it('keeps the task as found when the parent cannot be read', async () => {
        const s = session({
            call: (name, args) =>
                name === 'get_issue' && args.id === 'KOD-20'
                    ? issues['KOD-20']
                    : name === 'list_issues'
                      ? { issues: [] }
                      : (() => {
                            throw new TrackerUnavailableError('down');
                        })(),
        });
        const task = await found(s, 'KOD-20');
        expect(task.parent).toEqual({ id: 'KOD-19', title: undefined });
        expect(task.description).toBe('Archive part of the parent issue.');
    });
});

describe('LinearTracker: a parent named by its internal id, sub-issues by parent', () => {
    const context = { organizationAndTeamData: { organizationId: 'org-1' } };
    const PARENT_UUID = '7a1f0c2e-0000-4000-8000-000000000019';

    it('reads a parent the issue names by uuid, under its identifier', async () => {
        const s = session({
            call: (name, args) => {
                if (name !== 'get_issue') {
                    return { issues: [] };
                }
                return args.id === 'KOD-20'
                    ? {
                          id: 'KOD-20',
                          title: 'Bulk archive',
                          description: 'Part of the parent.',
                          parentId: PARENT_UUID,
                      }
                    : {
                          id: 'KOD-19',
                          uuid: PARENT_UUID,
                          title: 'Ticket list: bulk actions',
                          description: 'A checkbox selects the ticket.',
                      };
            },
        });
        const tracker = new LinearTracker(s);
        const read = await tracker.read(ref('KOD-20'), context);
        if (read.status !== 'found') {
            throw new Error('KOD-20 not found');
        }
        const task = await tracker.relate(read.task, context);
        expect(task.parent).toMatchObject({
            id: 'KOD-19',
            title: 'Ticket list: bulk actions',
        });
    });

    const parent = {
        id: 'KOD-19',
        title: 'Bulk actions',
        description: 'Select and archive.',
    };
    const relate = async (listIssues: MCPToolRaw, answer: () => unknown) => {
        const s = session({
            tools: [tool('get_issue'), listIssues],
            call: (name) => (name === 'get_issue' ? parent : answer()),
        });
        const tracker = new LinearTracker(s);
        const read = await tracker.read(ref('KOD-19'), context);
        if (read.status !== 'found') {
            throw new Error('KOD-19 not found');
        }
        return { s, task: await tracker.relate(read.task, context) };
    };

    it('never lists issues through a tool that has no parent filter', async () => {
        const { s, task } = await relate(
            tool('list_issues', { properties: { query: {}, limit: {} } }),
            () => ({ issues: [{ id: 'KOD-7', title: 'Unrelated' }] }),
        );
        expect(task.subtasks).toBeUndefined();
        expect(s.calls.map(([name]) => name)).not.toContain('list_issues');
    });

    it('keeps the issues, not their team or state, up to the cap', async () => {
        const { task } = await relate(
            tool('list_issues', { properties: { parentId: {}, limit: {} } }),
            () => ({
                issues: Array.from({ length: 30 }, (_, i) => ({
                    id: `KOD-${100 + i}`,
                    title: `Piece ${i}`,
                    team: { id: 'team-uuid', name: 'Platform' },
                    state: { id: 'state-uuid', name: 'Todo' },
                })),
            }),
        );
        expect(task.subtasks).toHaveLength(25);
        expect(task.subtasks?.every((t) => t.id.startsWith('KOD-'))).toBe(true);
    });
});

describe('GitIssuesTracker: the parent and sub-issues GitHub links', () => {
    const context = {
        organizationAndTeamData: { organizationId: 'org-1' },
        repository: { owner: 'acme', name: 'web' },
    };
    const issues: Record<number, Record<string, unknown>> = {
        12: {
            number: 12,
            title: 'Bulk archive',
            body: 'Archive part of the parent.',
            parent: { number: 11, repository: 'acme/web' },
        },
        11: {
            number: 11,
            title: 'Bulk actions',
            body: '- A checkbox selects the ticket\n- Archive selected archives them',
            subIssues: [{ number: 12, title: 'Bulk archive', state: 'open' }],
        },
        20: {
            number: 20,
            title: 'Export',
            body: 'Export the list.',
            parent: { number: 3, repository: 'acme/specs' },
        },
    };
    const git = () =>
        new GitIssuesTracker(
            session({
                call: (_name, args) => ({
                    success: true,
                    data: issues[args.issueNumber as number] ?? null,
                }),
            }),
        );
    const found = async (n: string) => {
        const tracker = git();
        const read = await tracker.read(ref(n), context);
        if (read.status !== 'found') {
            throw new Error(`${n} not found`);
        }
        return tracker.relate(read.task, context);
    };

    it("reads a sub-issue's parent in the same repository", async () => {
        const task = await found('#12');
        expect(task.parent).toMatchObject({ id: '#11', title: 'Bulk actions' });
        expect(task.parent?.description).toContain('Archive selected');
    });

    it('lists the sub-issues of a parent as #N', async () => {
        const task = await found('#11');
        expect(task.subtasks).toEqual([
            { id: '#12', title: 'Bulk archive', status: 'open' },
        ]);
    });

    it('names a parent in another repository without reading it', async () => {
        const task = await found('#20');
        expect(task.parent).toEqual({ id: 'acme/specs#3', title: undefined });
    });
    it("reads a number the team's pattern captured only when Git Issues is the chosen source (#2018)", () => {
        const [fromPattern] = extractTaskReferences(
            { branch: 'nina/T1234-gift-cards' },
            { taskIdPattern: 'T(\\d{4})' },
        );
        expect(fromPattern).toMatchObject({ id: '1234', teamPattern: true });
        expect(git().canRead(fromPattern)).toBe(false);
        expect(
            new GitIssuesTracker(session({}), true).canRead(fromPattern),
        ).toBe(true);
        const auto = buildTaskTrackers([
            server({
                name: 'Git Issues',
                integrationId: 'kodus-issues-default',
            }),
        ]);
        const chosen = buildTaskTrackers(
            [
                server({
                    name: 'Git Issues',
                    integrationId: 'kodus-issues-default',
                }),
            ],
            { taskSource: 'kodus-issues-default' },
        );
        expect(auto[0].canRead(fromPattern)).toBe(false);
        expect(chosen[0].canRead(fromPattern)).toBe(true);
    });

    it('says why Git Issues failed', async () => {
        const failing = new GitIssuesTracker(
            session({
                call: () => ({ success: false, message: 'Bad credentials' }),
            }),
        );
        await expect(failing.read(ref('#12'), context)).resolves.toMatchObject({
            status: 'error',
            message: 'Git Issues failed: Bad credentials',
        });
    });
});
