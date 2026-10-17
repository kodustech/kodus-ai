/**
 * Composition of a custom agent's extra tools, and the org filter applied
 * before an MCP connection can be selected.
 */
import type { MCPAdapter, MCPTool } from '@libs/mcp-server/mcp-adapter';

// One shared warn so the tests can read what the module logger wrote.
const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import {
    buildCustomAgentTools,
    loadCustomAgentMcpServers,
    sandboxFileWriter,
} from '@libs/code-review/infrastructure/agents/adapters/custom-agent-tools';
import { KODUS_MCP_INTEGRATION_ID } from '@libs/mcp-server/services/mcp-manager.service';

const remoteCommands = {
    grep: jest.fn(),
    read: jest.fn(),
    listDir: jest.fn(),
    exec: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 })),
};

const astGrepInstalled = {
    ...remoteCommands,
    exec: jest.fn(async () => ({
        stdout: 'ast-grep 0.45.3',
        stderr: '',
        exitCode: 0,
    })),
};

function adapterWith(tools: MCPTool[]): MCPAdapter {
    return {
        connect: jest.fn(async () => {}),
        disconnect: jest.fn(async () => {}),
        getTools: jest.fn(async () => tools),
        executeTool: jest.fn(async () => 'ok'),
    } as unknown as MCPAdapter;
}

const readTool = {
    name: 'get_ticket',
    description: 'Get a ticket',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: jest.fn(),
} as MCPTool;

describe('buildCustomAgentTools', () => {
    it('offers astGrep when the sandbox can exec and write, MCP tools when selected', async () => {
        const set = await buildCustomAgentTools(
            {
                tools: {
                    astGrepConfig:
                        'id: no-raw-sql\nlanguage: ts\nrule:\n  pattern: db.raw($Q)',
                    mcp: [
                        { integrationId: 'int-tracker', tools: ['get_ticket'] },
                    ],
                },
            },
            {
                remoteCommands: astGrepInstalled,
                writeFile: jest.fn(async () => {}),
                changedFiles: ['src/a.ts'],
                readTargetFile: jest.fn(async () => null),
                mcp: {
                    loadServers: jest.fn(async () => [
                        {
                            name: 'Tracker',
                            type: 'http' as const,
                            integrationId: 'int-tracker',
                        },
                    ]),
                    createAdapter: () => adapterWith([readTool]),
                },
            },
        );
        expect(set.tools.map((t) => t.name)).toEqual([
            'astGrep',
            'Tracker__get_ticket',
        ]);
        expect(set.tools[0].inputSchema.properties).toHaveProperty('useRules');
    });

    it('leaves astGrep out when the sandbox has no ast-grep binary', async () => {
        const set = await buildCustomAgentTools(
            { tools: {} },
            {
                remoteCommands,
                writeFile: jest.fn(async () => {}),
                changedFiles: ['src/a.ts'],
            },
        );
        expect(set.tools).toEqual([]);
        expect(remoteCommands.exec).toHaveBeenCalledWith('ast-grep --version');
    });

    it('leaves astGrep out when the sandbox cannot write its neutral config', async () => {
        const set = await buildCustomAgentTools(
            { tools: {} },
            { remoteCommands, changedFiles: [] },
        );
        expect(set.tools).toEqual([]);
    });

    it('runs without MCP tools when the connections cannot be loaded', async () => {
        const set = await buildCustomAgentTools(
            {
                tools: {
                    mcp: [
                        { integrationId: 'int-tracker', tools: ['get_ticket'] },
                    ],
                },
            },
            {
                changedFiles: [],
                mcp: {
                    loadServers: jest.fn(async () => {
                        throw new Error('mcp-manager down');
                    }),
                },
            },
        );
        expect(set.tools).toEqual([]);
        await expect(set.close()).resolves.toBeUndefined();
    });

    it('logs unavailable MCP tools with the review identifiers', async () => {
        mockWarn.mockClear();
        await buildCustomAgentTools(
            {
                tools: {
                    mcp: [
                        { integrationId: 'int-tracker', tools: ['get_ticket'] },
                    ],
                },
            },
            {
                changedFiles: [],
                logContext: { organizationId: 'org-1', prNumber: 7 },
                mcp: {
                    loadServers: jest.fn(async () => {
                        throw new Error('mcp-manager down');
                    }),
                },
            },
        );
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    prNumber: 7,
                }),
            }),
        );
    });
});

describe('loadCustomAgentMcpServers', () => {
    const org = { organizationId: 'org-a', teamId: 'team-a' } as any;

    it('keeps only the selected connections of the caller organization', async () => {
        const getConnections = jest.fn(async (_o: any, format?: boolean) =>
            format
                ? [
                      { name: 'Tracker', type: 'http' },
                      { name: 'Wiki', type: 'http' },
                      { name: 'Other Org Tracker', type: 'http' },
                  ]
                : [
                      {
                          organizationId: 'org-a',
                          integrationId: 'int-tracker',
                          appName: 'Tracker',
                      },
                      {
                          organizationId: 'org-a',
                          integrationId: 'int-wiki',
                          appName: 'Wiki',
                      },
                      {
                          organizationId: 'org-b',
                          integrationId: 'int-tracker',
                          appName: 'Other Org Tracker',
                      },
                  ],
        );

        const servers = await loadCustomAgentMcpServers(
            { getConnections },
            org,
            ['int-tracker'],
        );
        expect(servers).toEqual([
            { name: 'Tracker', type: 'http', integrationId: 'int-tracker' },
        ]);
    });

    it('never offers the Kodus MCP: the review already gives the agent the code, the pull request and the memories', async () => {
        const getConnections = jest.fn(async (_o: any, format?: boolean) =>
            format
                ? [
                      { name: 'Kodus MCP', type: 'http' },
                      { name: 'Tracker', type: 'http' },
                  ]
                : [
                      {
                          organizationId: 'org-a',
                          integrationId: KODUS_MCP_INTEGRATION_ID,
                          appName: 'Kodus MCP',
                      },
                      {
                          organizationId: 'org-a',
                          integrationId: 'int-tracker',
                          appName: 'Tracker',
                      },
                  ],
        );

        const servers = await loadCustomAgentMcpServers(
            { getConnections },
            org,
            [KODUS_MCP_INTEGRATION_ID, 'int-tracker'],
        );
        expect(servers.map((s) => s.integrationId)).toEqual(['int-tracker']);
    });

    it('does not fetch credentials when nothing selected belongs to the organization', async () => {
        const getConnections = jest.fn(async () => [
            {
                organizationId: 'org-b',
                integrationId: 'int-tracker',
                appName: 'Tracker',
            },
        ]);
        const servers = await loadCustomAgentMcpServers(
            { getConnections },
            org,
            ['int-tracker'],
        );
        expect(servers).toEqual([]);
        expect(getConnections).toHaveBeenCalledTimes(1);
    });
});

describe('sandboxFileWriter', () => {
    it('writes repository-relative paths under the sandbox repo root', async () => {
        const writeFile = jest.fn(async () => {});
        await sandboxFileWriter({ repoDir: '/work/repo/', writeFile })(
            '.kody-ast-grep-x/sgconfig.yml',
            'ruleDirs: []\n',
        );
        expect(writeFile).toHaveBeenCalledWith(
            '/work/repo/.kody-ast-grep-x/sgconfig.yml',
            'ruleDirs: []\n',
        );
    });
});
