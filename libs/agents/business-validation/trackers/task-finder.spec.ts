import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { resolveTasks } from '../task-resolver';
import { extractTaskReferences } from '../task-references';
import { CustomMcpTracker } from './custom-mcp.tracker';
import { LinearTracker } from './linear.tracker';
import { TaskNotFoundError, type McpToolSession } from './mcp-tool-session';
import {
    type AgentRun,
    createTaskFinder,
    type FoundByFinder,
} from './task-finder';

/**
 * What the task finder accepts when a tracker's direct read misses: the
 * agent's moves are scripted, so these pin the rules, not the model. The
 * domain is invented.
 */

const tool = (
    name: string,
    properties: Record<string, any> = {},
    annotations?: Record<string, unknown>,
): MCPToolRaw =>
    ({
        name,
        description: name,
        inputSchema: { type: 'object', properties },
        ...(annotations ? { annotations } : {}),
    }) as MCPToolRaw;

const taskOf = (found: FoundByFinder | undefined) =>
    found && 'task' in found ? found.task : undefined;

/** An agent that makes these calls, in order, and stops. */
function scripted(
    moves: Array<[string, Record<string, unknown>]>,
): AgentRun & { offered: string[] } {
    const offered: string[] = [];
    const run = async (spec: AgentSpec) => {
        offered.push(
            ...spec.tools
                .list()
                .map((t) => t.name)
                .filter((n) => n !== 'report_task_not_found'),
        );
        for (const [name, args] of moves) {
            const t = spec.tools.get(name);
            if (!t) {
                continue;
            }
            const out = await t.execute(args, {} as any);
            if (String(out.output).includes('Answer DONE')) {
                return;
            }
        }
    };
    return Object.assign(run, { offered });
}

const ref = (text: string) => extractTaskReferences({ command: text })[0];

const STICKY = {
    id: 'SAA-96',
    uuid: '2f1c0b6e-0000-4000-8000-000000000001',
    title: 'Sticky notes',
    description: '## Acceptance criteria\n- Drag to reorder',
    url: 'https://linear.app/acme/issue/SAA-96/sticky-notes',
};

describe('task finder', () => {
    it('reads the task through a tool the direct read does not know (renamed get_issue)', async () => {
        const agent = scripted([['get_issue_v2', { issueId: 'SAA-96' }]]);
        const found = await createTaskFinder(agent)({
            reference: ref('SAA-96'),
            tracker: 'Linear',
            tools: [tool('get_issue_v2', { issueId: { type: 'string' } })],
            call: async () => ({ issue: STICKY }),
        });
        expect(found).toEqual({
            task: expect.objectContaining({
                id: 'SAA-96',
                title: 'Sticky notes',
                description: expect.stringContaining('Drag to reorder'),
            }),
            tools: ['get_issue_v2'],
        });
    });

    it('lists what a reader needs first (a site id), then reads', async () => {
        const calls: string[] = [];
        const agent = scripted([
            ['getJiraIssue', { issueIdOrKey: 'SHOP-12' }],
            ['getAccessibleAtlassianResources', {}],
            ['getJiraIssue', { cloudId: 'c1', issueIdOrKey: 'SHOP-12' }],
        ]);
        const found = await createTaskFinder(agent)({
            reference: ref('SHOP-12'),
            tracker: 'Jira',
            tools: [
                tool('getAccessibleAtlassianResources'),
                tool('getJiraIssue', {
                    cloudId: { type: 'string' },
                    issueIdOrKey: { type: 'string' },
                }),
            ],
            call: async (name, args) => {
                calls.push(name);
                if (name === 'getAccessibleAtlassianResources') {
                    return [{ id: 'c1', url: 'https://acme.atlassian.net' }];
                }
                if (!args.cloudId) {
                    throw new Error('cloudId is required');
                }
                return {
                    key: 'SHOP-12',
                    fields: {
                        summary: 'Gift cards',
                        description: 'Pay with a gift card.',
                    },
                };
            },
        });
        expect(taskOf(found)).toMatchObject({
            id: 'SHOP-12',
            title: 'Gift cards',
        });
        expect(calls).toEqual([
            'getJiraIssue',
            'getAccessibleAtlassianResources',
            'getJiraIssue',
        ]);
    });

    it('reports a missing task only after the server answered', async () => {
        const search = tool('search_issues', { query: { type: 'string' } });
        const answered = await createTaskFinder(
            scripted([
                ['search_issues', { query: 'SAA-999' }],
                ['report_task_not_found', {}],
            ]),
        )({
            reference: ref('SAA-999'),
            tracker: 'Linear',
            tools: [search],
            call: async () => ({ issues: [] }),
        });
        expect(answered).toEqual({ notFound: true, tools: ['search_issues'] });

        const down = await createTaskFinder(
            scripted([
                ['search_issues', { query: 'SAA-999' }],
                ['report_task_not_found', {}],
            ]),
        )({
            reference: ref('SAA-999'),
            tracker: 'Linear',
            tools: [search],
            call: async () => {
                throw new Error('fetch failed');
            },
        });
        expect(down).toBeUndefined();
    });

    it('never stands in another task: a search that returns others finds nothing', async () => {
        const agent = scripted([['search_issues', { query: 'SAA-99' }]]);
        const found = await createTaskFinder(agent)({
            reference: ref('SAA-99'),
            tracker: 'Linear',
            tools: [tool('search_issues', { query: { type: 'string' } })],
            call: async () => ({
                issues: [
                    { ...STICKY, description: 'Blocks SAA-99' },
                    { id: 'SAA-9', title: 'Something else', description: 'x' },
                ],
            }),
        });
        expect(found).toBeUndefined();
    });

    it('accepts the exact task when a search returns it with others', async () => {
        const agent = scripted([['search_issues', { query: 'SAA-96' }]]);
        const found = await createTaskFinder(agent)({
            reference: ref('SAA-96'),
            tracker: 'Linear',
            tools: [tool('search_issues', { query: { type: 'string' } })],
            call: async () => ({
                issues: [
                    { id: 'SAA-9', title: 'Something else', description: 'x' },
                    STICKY,
                ],
            }),
        });
        expect(taskOf(found)?.title).toBe('Sticky notes');
    });

    it('reads an id kept under a new name, never a parent that names the task', async () => {
        const agent = scripted([['get_ticket', { ticket: 'SHOP-12' }]]);
        const read = (payload: unknown) =>
            createTaskFinder(agent)({
                reference: ref('SHOP-12'),
                tracker: 'Jira',
                tools: [tool('get_ticket', { ticket: { type: 'string' } })],
                call: async () => payload,
            });
        expect(
            await read({
                issueKey: 'SHOP-12',
                summary: 'Gift cards',
                body: 'x',
            }),
        ).toBeDefined();
        expect(
            await read({
                issueKey: 'SHOP-13',
                parentKey: 'SHOP-12',
                summary: 'Sub',
                body: 'x',
            }),
        ).toBeUndefined();
    });

    it('keeps looking when a search lists the task without its description', async () => {
        const agent = scripted([
            ['search_issues', { query: 'SAA-96' }],
            ['get_issue', { id: 'u-1' }],
        ]);
        const found = await createTaskFinder(agent)({
            reference: ref('SAA-96'),
            tracker: 'Linear',
            tools: [
                tool('search_issues', { query: { type: 'string' } }),
                tool('get_issue', { id: { type: 'string' } }),
            ],
            call: async (name) =>
                name === 'search_issues'
                    ? [{ identifier: 'SAA-96', title: 'Sticky notes' }]
                    : { ...STICKY, id: 'u-1', identifier: 'SAA-96' },
        });
        expect(taskOf(found)?.description).toContain('Drag to reorder');
        expect(found?.tools).toEqual(['search_issues', 'get_issue']);
    });

    it('never takes a task read without its description, unless the tracker says it is empty', async () => {
        const read = (payload: unknown) =>
            createTaskFinder(scripted([['get_issue', { id: 'SAA-96' }]]))({
                reference: ref('SAA-96'),
                tracker: 'Linear',
                tools: [tool('get_issue', { id: { type: 'string' } })],
                call: async () => payload,
            });
        // `fields: ['id', 'title']`: the description was left out.
        expect(
            await read({ id: 'SAA-96', title: 'Sticky notes' }),
        ).toBeUndefined();
        // Asked for, and empty: a task with only a title.
        expect(
            taskOf(
                await read({
                    id: 'SAA-96',
                    title: 'Sticky notes',
                    description: null,
                }),
            )?.title,
        ).toBe('Sticky notes');
    });

    it("asks a single-item read for every field, so Jira's custom fields come back", async () => {
        const seen: Array<Record<string, unknown>> = [];
        await createTaskFinder(
            scripted([
                ['getJiraIssue', { cloudId: 'c1', issueIdOrKey: 'SHOP-12' }],
            ]),
        )({
            reference: ref('SHOP-12'),
            tracker: 'Jira',
            tools: [
                tool('getJiraIssue', {
                    cloudId: { type: 'string' },
                    issueIdOrKey: { type: 'string' },
                    fields: { type: 'array', items: { type: 'string' } },
                    expand: { type: 'string' },
                }),
            ],
            call: async (_name, args) => {
                seen.push(args);
                return undefined;
            },
        });
        expect(seen[0]).toEqual({
            cloudId: 'c1',
            issueIdOrKey: 'SHOP-12',
            fields: ['*all'],
            expand: 'names',
        });
    });

    it("keeps the agent's own picks and still adds every field and their names", async () => {
        const seen: Array<Record<string, unknown>> = [];
        await createTaskFinder(
            scripted([
                [
                    'getJiraIssue',
                    {
                        issueIdOrKey: 'SHOP-12',
                        fields: ['summary'],
                        expand: 'renderedFields',
                    },
                ],
            ]),
        )({
            reference: ref('SHOP-12'),
            tracker: 'Jira',
            tools: [
                tool('getJiraIssue', {
                    issueIdOrKey: { type: 'string' },
                    fields: { type: 'array', items: { type: 'string' } },
                    expand: { type: 'string' },
                }),
            ],
            call: async (_name, args) => {
                seen.push(args);
                return undefined;
            },
        });
        expect(seen[0]).toMatchObject({
            fields: ['summary', '*all'],
            expand: 'renderedFields,names',
        });
    });

    it('offers only tools that read', async () => {
        const agent = scripted([]);
        await createTaskFinder(agent)({
            reference: ref('SAA-96'),
            tracker: 'Linear',
            tools: [
                tool('get_issue', { id: { type: 'string' } }),
                tool('save_issue'),
                tool('update_issue'),
                tool('archive_issue'),
                tool('get_status', {}, { destructiveHint: true }),
                tool('list_teams'),
            ],
            call: async () => undefined,
        });
        expect(agent.offered).toEqual(['get_issue', 'list_teams']);
    });

    it('keeps the tool that reads one task when a server lists too many', async () => {
        const agent = scripted([]);
        await createTaskFinder(agent)({
            reference: ref('SAA-96'),
            tracker: 'Plugin',
            tools: [
                ...Array.from({ length: 45 }, (_, i) =>
                    tool(`get_report_${i}`),
                ),
                tool('get_task', { task_id: { type: 'string' } }),
            ],
            call: async () => undefined,
        });
        expect(agent.offered).toHaveLength(40);
        expect(agent.offered[0]).toBe('get_task');
    });

    it('offers only tools marked read-only when the server marks them (Linear, Rovo)', async () => {
        const agent = scripted([]);
        await createTaskFinder(agent)({
            reference: ref('SAA-96'),
            tracker: 'Linear',
            tools: [
                tool('get_issue', {}, { readOnlyHint: true }),
                tool('fetch_everything', {}, { readOnlyHint: false }),
                tool('get_cycle'),
            ],
            call: async () => undefined,
        });
        expect(agent.offered).toEqual(['get_issue']);
    });

    it("takes `#12` only from the PR's repository, never another tracker's 12", async () => {
        const agent = scripted([['get_item', { id: 12 }]]);
        const read = (url: string) =>
            createTaskFinder(agent)({
                reference: ref('#12'),
                tracker: 'Issues',
                repository: { owner: 'acme', name: 'notes' },
                tools: [tool('get_item', { id: { type: 'number' } })],
                call: async () => ({
                    number: 12,
                    title: 'Export notes',
                    body: 'Exports as CSV.',
                    html_url: url,
                }),
            });
        expect(
            await read('https://github.com/acme/notes/issues/12'),
        ).toBeDefined();
        expect(
            await read('https://github.com/acme/billing/issues/12'),
        ).toBeUndefined();
    });
});

describe('the resolver asks the finder only after every direct read missed', () => {
    function linearSession(
        answer: (args: Record<string, unknown>) => unknown,
    ): McpToolSession {
        return {
            called: [] as string[],
            tools: async () => [
                tool('get_issue', { id: { type: 'string' } }),
                tool('get_team', { query: { type: 'string' } }),
            ],
            call: async (name: string, args: Record<string, unknown>) => {
                if (name === 'get_team') {
                    return { key: 'SAA' };
                }
                return answer(args);
            },
            close: async () => undefined,
        } as any;
    }
    const context = { organizationAndTeamData: {} as any };

    it('recovers a task the direct read can no longer parse, and says so', async () => {
        const finder = jest.fn(async () => ({
            task: { id: 'SAA-96', title: 'Sticky notes', description: 'x' },
            tools: ['get_issue'],
        }));
        const linear = new LinearTracker(
            linearSession(() => 'issue moved to a new shape'),
        ).useFinder(finder);

        const resolution = await resolveTasks(
            [ref('SAA-96')],
            [linear],
            context,
        );

        expect(finder).toHaveBeenCalled();
        expect(resolution.kind).toBe('found');
        expect(resolution.attempts.at(-1)).toMatchObject({
            tracker: 'Linear',
            status: 'found',
            byAgent: true,
        });
    });

    it("reads a broken reader's miss as a typo once the agent finds no such task", async () => {
        const linear = new LinearTracker(
            linearSession(({ id }) => {
                if (id === 'SAA-999') {
                    throw new Error('Invalid arguments for get_issue');
                }
                throw new TaskNotFoundError('not found');
            }),
        ).useFinder(async () => ({ notFound: true, tools: ['list_issues'] }));

        const resolution = await resolveTasks(
            [ref('SAA-999')],
            [linear],
            context,
        );

        expect(resolution).toMatchObject({
            kind: 'not_found',
            looksIntended: true,
        });
    });

    it('does not search a tracker whose team the key is not', async () => {
        const finder = jest.fn(async () => undefined);
        const linear = new LinearTracker(
            linearSession(() => {
                throw new TaskNotFoundError('not found');
            }),
        ).useFinder(finder);

        await resolveTasks([ref('KOD-10')], [linear], context);

        expect(finder).not.toHaveBeenCalled();
    });

    it('searches a plugin that cannot list its keys', async () => {
        const finder = jest.fn(async () => undefined);
        const plugin = new CustomMcpTracker('Acme', {
            called: [] as string[],
            tools: async () => [
                tool('get_task', { task_id: { type: 'string' } }),
            ],
            call: async () => {
                throw new TaskNotFoundError('not found');
            },
            close: async () => undefined,
        } as any).useFinder(finder);

        await resolveTasks([ref('KOD-10')], [plugin], context);

        expect(finder).toHaveBeenCalled();
    });

    it('leaves a tracker that is down to the re-check, not to an agent', async () => {
        const finder = jest.fn(async () => undefined);
        const linear = new LinearTracker(
            linearSession(() => {
                throw new Error('fetch failed: ECONNRESET');
            }),
        ).useFinder(finder);

        const resolution = await resolveTasks(
            [ref('SAA-96')],
            [linear],
            context,
        );

        expect(finder).not.toHaveBeenCalled();
        expect(resolution.kind).toBe('tracker_unavailable');
    });

    it('never runs when another tracker read it directly', async () => {
        const finder = jest.fn(async () => undefined);
        const missing = new LinearTracker(
            linearSession(() => {
                throw new TaskNotFoundError('not found');
            }),
        ).useFinder(finder);
        const reads = new LinearTracker(linearSession(() => STICKY));

        const resolution = await resolveTasks(
            [ref('SAA-96')],
            [missing, reads],
            context,
        );

        expect(resolution.kind).toBe('found');
        expect(finder).not.toHaveBeenCalled();
    });
});
