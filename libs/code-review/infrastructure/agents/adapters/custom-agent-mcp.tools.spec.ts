/**
 * Read-only MCP tools for custom agents — no network. The MCP adapter is a
 * fake, so the tests pin which tools are offered, that a tool outside the
 * allowed set is refused even when called by name, and that failures come back
 * as tool output instead of being thrown.
 */
import type {
    MCPAdapter,
    MCPAdapterConfig,
    MCPTool,
} from '@libs/mcp-server/mcp-adapter';

import {
    buildCustomAgentMcpTools,
    isReadOnlyMcpTool,
    mcpToolExposedName,
    type CustomAgentMcpServer,
} from '@libs/code-review/infrastructure/agents/adapters/custom-agent-mcp.tools';

const ctx = { runId: 'r' } as any;

function tool(name: string, annotations?: Record<string, unknown>): MCPTool {
    return {
        name,
        description: `${name} description`,
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
        annotations,
        execute: jest.fn(),
    };
}

function fakeAdapter(
    tools: MCPTool[],
    executeTool: jest.Mock = jest.fn(async (name: string) => ({
        content: [{ type: 'text', text: `${name} ok` }],
    })),
) {
    const adapter = {
        connect: jest.fn(async () => {}),
        disconnect: jest.fn(async () => {}),
        getTools: jest.fn(async () => tools),
        executeTool,
    } as unknown as MCPAdapter & {
        executeTool: jest.Mock;
        disconnect: jest.Mock;
        connect: jest.Mock;
    };
    return adapter;
}

const TRACKER: CustomAgentMcpServer = {
    name: 'Tracker',
    type: 'http',
    url: 'https://mcp.tracker.example/mcp',
    integrationId: 'int-tracker',
};

const WIKI: CustomAgentMcpServer = {
    name: 'Wiki',
    type: 'http',
    url: 'https://mcp.wiki.example/mcp',
    integrationId: 'int-wiki',
};

describe('isReadOnlyMcpTool', () => {
    it('trusts readOnlyHint when the server marks its tools', () => {
        expect(
            isReadOnlyMcpTool(tool('get_ticket', { readOnlyHint: true }), true),
        ).toBe(true);
        expect(
            isReadOnlyMcpTool(
                tool('get_ticket', { readOnlyHint: false }),
                true,
            ),
        ).toBe(false);
        // A marking server leaves an unmarked tool out.
        expect(isReadOnlyMcpTool(tool('get_ticket'), true)).toBe(false);
    });

    it.each([
        'create_ticket',
        'updateIssue',
        'deletePage',
        'write-file',
        'post_comment',
        'sendMessage',
        'add_label',
        'removeWatcher',
        'set_status',
        'editPage',
        'close_issue',
        'mergePullRequest',
        'issues.create',
        // Not a read verb: a blocklist would let these through.
        'archive_project',
        'transition_issue',
        'run_pipeline',
        'assignTicket',
        'jira_comment',
        // A read verb next to a write verb is still a write.
        'get_or_create_ticket',
        'list_and_delete_pages',
    ])(
        'falls back to the name when the server marks nothing: %s is a write',
        (name) => {
            expect(isReadOnlyMcpTool(tool(name), false)).toBe(false);
        },
    );

    it.each([
        'get_ticket',
        'searchIssues',
        'list_pages',
        'fetch-document',
        'getSettings',
        'read_file',
        'find_users',
        'query_metrics',
        'describeTable',
        'view_dashboard',
        'show_config',
        'lookupAccount',
        'tracker_get_issue',
        // Nouns that are also verbs do not make a read tool a write.
        'list_labels',
        'get_comments',
        'list_runs',
        'search_posts',
        'list_commits',
    ])(
        'falls back to the name when the server marks nothing: %s is a read',
        (name) => {
            expect(isReadOnlyMcpTool(tool(name), false)).toBe(true);
        },
    );
});

describe('buildCustomAgentMcpTools', () => {
    it('offers only the selected tools that are read-only, named Server__tool', async () => {
        const adapter = fakeAdapter([
            tool('get_ticket', { readOnlyHint: true }),
            tool('search_tickets', { readOnlyHint: true }),
            tool('create_ticket', { readOnlyHint: false }),
            tool('get_attachment'), // unmarked on a marking server
        ]);
        const set = await buildCustomAgentMcpTools({
            selections: [
                {
                    integrationId: 'int-tracker',
                    tools: ['get_ticket', 'create_ticket', 'get_attachment'],
                },
            ],
            servers: [TRACKER],
            createAdapter: () => adapter,
        });

        expect(set.tools.map((t) => t.name)).toEqual(['Tracker__get_ticket']);
        expect(set.tools[0].description).toContain('Tracker:get_ticket');
        expect(set.tools[0].inputSchema).toEqual({
            type: 'object',
            properties: { id: { type: 'string' } },
        });
    });

    it('never offers a write tool even when the agent selected it and the server marks nothing', async () => {
        const adapter = fakeAdapter([tool('get_page'), tool('update_page')]);
        const set = await buildCustomAgentMcpTools({
            selections: [
                {
                    integrationId: 'int-wiki',
                    tools: ['get_page', 'update_page'],
                },
            ],
            servers: [WIKI],
            createAdapter: () => adapter,
        });
        expect(set.tools.map((t) => t.name)).toEqual(['Wiki__get_page']);
    });

    it('on a server that marks nothing, offers only selected read-named tools', async () => {
        const adapter = fakeAdapter([
            tool('get_page'),
            tool('search_pages'),
            tool('archive_page'),
            tool('page_history'),
        ]);
        const set = await buildCustomAgentMcpTools({
            selections: [
                {
                    integrationId: 'int-wiki',
                    // search_pages is read-named but not selected.
                    tools: ['get_page', 'archive_page', 'page_history'],
                },
            ],
            servers: [WIKI],
            createAdapter: () => adapter,
        });
        expect(set.tools.map((t) => t.name)).toEqual(['Wiki__get_page']);

        const refused = await set.call('Wiki__archive_page', {});
        expect(refused.isError).toBe(true);
        expect(adapter.executeTool).not.toHaveBeenCalled();
    });

    it('refuses to execute a tool outside the allowed set when called by name', async () => {
        const adapter = fakeAdapter([
            tool('get_ticket', { readOnlyHint: true }),
            tool('create_ticket', { readOnlyHint: false }),
        ]);
        const set = await buildCustomAgentMcpTools({
            selections: [
                {
                    integrationId: 'int-tracker',
                    tools: ['get_ticket', 'create_ticket'],
                },
            ],
            servers: [TRACKER],
            createAdapter: () => adapter,
        });

        for (const name of [
            'Tracker__create_ticket',
            'create_ticket',
            'Tracker:create_ticket',
        ]) {
            const r = await set.call(name, { id: '1' }, ctx);
            expect(r.isError).toBe(true);
            expect(r.output).toMatch(/not allowed/i);
        }
        expect(adapter.executeTool).not.toHaveBeenCalled();

        const ok = await set.call('Tracker__get_ticket', { id: '1' }, ctx);
        expect(ok.isError).toBeFalsy();
        expect(ok.output).toContain('get_ticket ok');
        expect(adapter.executeTool).toHaveBeenCalledWith('get_ticket', {
            id: '1',
        });
    });

    it('ignores servers the agent did not select and selections without a connection', async () => {
        const created: string[] = [];
        const set = await buildCustomAgentMcpTools({
            selections: [
                { integrationId: 'int-wiki', tools: ['get_page'] },
                { integrationId: 'int-missing', tools: ['get_x'] },
            ],
            servers: [TRACKER, WIKI],
            createAdapter: (config: MCPAdapterConfig) => {
                created.push(config.servers[0].name);
                return fakeAdapter([tool('get_page'), tool('get_ticket')]);
            },
        });
        expect(created).toEqual(['Wiki']);
        expect(set.tools.map((t) => t.name)).toEqual(['Wiki__get_page']);
    });

    it('returns a timeout as error output instead of throwing', async () => {
        const executeTool = jest.fn(
            () => new Promise(() => {}), // never settles
        );
        const adapter = fakeAdapter(
            [tool('get_ticket', { readOnlyHint: true })],
            executeTool,
        );
        const set = await buildCustomAgentMcpTools({
            selections: [
                { integrationId: 'int-tracker', tools: ['get_ticket'] },
            ],
            servers: [TRACKER],
            createAdapter: () => adapter,
            callTimeoutMs: 20,
        });

        const r = await set.tools[0].execute({ id: '1' }, ctx);
        expect(r.isError).toBe(true);
        expect(r.output).toMatch(/timed out/i);
    });

    it('returns a thrown tool error as error output', async () => {
        const executeTool = jest.fn(async () => {
            throw new Error('upstream 500');
        });
        const adapter = fakeAdapter(
            [tool('get_ticket', { readOnlyHint: true })],
            executeTool,
        );
        const set = await buildCustomAgentMcpTools({
            selections: [
                { integrationId: 'int-tracker', tools: ['get_ticket'] },
            ],
            servers: [TRACKER],
            createAdapter: () => adapter,
        });
        const r = await set.tools[0].execute({}, ctx);
        expect(r.isError).toBe(true);
        expect(r.output).toContain('upstream 500');
    });

    it('drops a server that fails to connect and keeps the rest', async () => {
        const broken = fakeAdapter([tool('get_ticket')]);
        broken.connect.mockRejectedValueOnce(new Error('401'));
        const wiki = fakeAdapter([tool('get_page')]);
        const set = await buildCustomAgentMcpTools({
            selections: [
                { integrationId: 'int-tracker', tools: ['get_ticket'] },
                { integrationId: 'int-wiki', tools: ['get_page'] },
            ],
            servers: [TRACKER, WIKI],
            createAdapter: (config) =>
                config.servers[0].name === 'Tracker' ? broken : wiki,
        });
        expect(set.tools.map((t) => t.name)).toEqual(['Wiki__get_page']);
        expect(set.unavailable).toEqual(['Tracker']);
    });

    it('disconnects every adapter on close', async () => {
        const adapter = fakeAdapter([
            tool('get_ticket', { readOnlyHint: true }),
        ]);
        const set = await buildCustomAgentMcpTools({
            selections: [
                { integrationId: 'int-tracker', tools: ['get_ticket'] },
            ],
            servers: [TRACKER],
            createAdapter: () => adapter,
        });
        await set.close();
        expect(adapter.disconnect).toHaveBeenCalled();
    });

    it('builds provider-safe names', () => {
        expect(mcpToolExposedName('My Tracker!', 'get.ticket')).toBe(
            'My_Tracker__get_ticket',
        );
        expect(
            mcpToolExposedName('A'.repeat(80), 'b'.repeat(80)).length,
        ).toBeLessThanOrEqual(64);
    });
});
