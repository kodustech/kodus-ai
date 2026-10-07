import type { MCPServerConfig, MCPToolRaw } from '@libs/mcp-server/mcp-adapter';

import { extractTaskReferences } from '../task-references';
import { CustomMcpTracker, rankReadTools } from './custom-mcp.tracker';
import { LinearTracker } from './linear.tracker';
import {
    TrackerUnavailableError,
    type McpToolSession,
} from './mcp-tool-session';
import { buildTaskTrackers } from './tracker-catalog';

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
    return {
        calls,
        tools: async () => handlers.tools ?? [],
        call: async (name: string, args: Record<string, unknown>) => {
            calls.push([name, args]);
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
    const workItem = tool('wit_work_item', {
        properties: { id: { type: 'number' }, project: { type: 'string' } },
        required: ['id', 'project'],
    });

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
