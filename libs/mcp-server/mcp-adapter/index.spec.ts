const mockRegistry = {
    register: jest.fn(),
    listAllTools: jest.fn(),
    executeTool: jest.fn(),
    destroy: jest.fn(),
};

jest.mock('./registry', () => ({
    MCPRegistry: jest.fn().mockImplementation(() => mockRegistry),
}));

import { createMCPAdapter } from './index';

const servers = [
    {
        name: 'server-a',
        type: 'http' as const,
        url: 'http://localhost:3001/mcp',
    },
    {
        name: 'server-b',
        type: 'http' as const,
        url: 'http://localhost:3002/mcp',
    },
];

function rawTool(name: string, serverName: string) {
    return {
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object', properties: {} },
        serverName,
    };
}

describe('createMCPAdapter.getTools', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRegistry.register.mockResolvedValue(undefined);
    });

    it('still returns the other tools when two servers list the same name', async () => {
        mockRegistry.listAllTools.mockResolvedValue([
            rawTool('SAME_TOOL', 'server-a'),
            rawTool('read_file', 'server-a'),
            rawTool('SAME_TOOL', 'server-b'),
            rawTool('create_issue', 'server-b'),
        ]);

        const adapter = createMCPAdapter({ servers });
        await adapter.connect();

        const tools = await adapter.getTools();

        expect(tools.map((engineTool) => engineTool.name).sort()).toEqual([
            'create_issue',
            'read_file',
        ]);
    });

    it('returns every tool when no name is shared', async () => {
        mockRegistry.listAllTools.mockResolvedValue([
            rawTool('read_file', 'server-a'),
            rawTool('create_issue', 'server-b'),
        ]);

        const adapter = createMCPAdapter({ servers });
        await adapter.connect();

        const tools = await adapter.getTools();

        expect(tools.map((engineTool) => engineTool.name).sort()).toEqual([
            'create_issue',
            'read_file',
        ]);
    });

    it('reports the shared name to the caller so it can be surfaced', async () => {
        mockRegistry.listAllTools.mockResolvedValue([
            rawTool('SAME_TOOL', 'server-a'),
            rawTool('SAME_TOOL', 'server-b'),
            rawTool('read_file', 'server-a'),
        ]);
        const onError = jest.fn();

        const adapter = createMCPAdapter({ servers, onError });
        await adapter.connect();

        await adapter.getTools();

        expect(onError).toHaveBeenCalledTimes(1);
        const [error, source] = onError.mock.calls[0];
        expect(source).toBe('mcp-adapter');
        expect(error.message).toContain('SAME_TOOL');
        expect(error.message).toContain('server-a, server-b');
        expect(error.message).toContain('Rename it');
    });
});
