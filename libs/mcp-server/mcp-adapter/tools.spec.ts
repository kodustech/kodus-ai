import { mcpToolsToEngineTools } from './tools';
import { MCPToolRawWithServer } from './types';

function tool(name: string, serverName?: string): MCPToolRawWithServer {
    return {
        name,
        description: `${name} tool`,
        inputSchema: { type: 'object', properties: {} },
        serverName,
    };
}

describe('mcpToolsToEngineTools name conflicts', () => {
    it('keeps every other tool when two servers list the same name', () => {
        const conflicts: Array<{ toolName: string; servers: string[] }> = [];

        const tools = mcpToolsToEngineTools(
            [
                tool('SAME_TOOL', 'server-a'),
                tool('read_file', 'server-a'),
                tool('SAME_TOOL', 'server-b'),
                tool('create_issue', 'server-b'),
            ],
            (toolName, servers) => conflicts.push({ toolName, servers }),
        );

        expect(tools.map((engineTool) => engineTool.name).sort()).toEqual([
            'create_issue',
            'read_file',
        ]);
        expect(conflicts).toEqual([
            { toolName: 'SAME_TOOL', servers: ['server-a', 'server-b'] },
        ]);
    });

    it('does not treat one server listing a name twice as a conflict', () => {
        const onConflict = jest.fn();

        const tools = mcpToolsToEngineTools(
            [tool('read_file', 'server-a'), tool('read_file', 'server-a')],
            onConflict,
        );

        expect(onConflict).not.toHaveBeenCalled();
        expect(tools).toHaveLength(2);
    });

    it('returns every tool when no name is shared', () => {
        const onConflict = jest.fn();

        const tools = mcpToolsToEngineTools(
            [tool('read_file', 'server-a'), tool('create_issue', 'server-b')],
            onConflict,
        );

        expect(onConflict).not.toHaveBeenCalled();
        expect(tools.map((engineTool) => engineTool.name).sort()).toEqual([
            'create_issue',
            'read_file',
        ]);
    });

    it('drops only the shared name when no conflict handler is given', () => {
        const tools = mcpToolsToEngineTools([
            tool('SAME_TOOL', 'server-a'),
            tool('SAME_TOOL', 'server-b'),
            tool('read_file', 'server-a'),
        ]);

        expect(tools.map((engineTool) => engineTool.name)).toEqual([
            'read_file',
        ]);
    });
});
