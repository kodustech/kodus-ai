import { mcpToolsToEngineTools } from './tools';

describe('mcpToolsToEngineTools', () => {
    const tool = (name: string, serverName: string) => ({
        name,
        serverName,
        description: `${name} on ${serverName}`,
        inputSchema: { type: 'object', properties: {} },
    });

    it('keeps one tool for a name listed by two servers and every unique tool', () => {
        const tools = mcpToolsToEngineTools([
            tool('SAME_TOOL', 'server-a'),
            tool('only_a', 'server-a'),
            tool('SAME_TOOL', 'server-b'),
            tool('only_b', 'server-b'),
        ]);

        expect(tools.map((t) => t.name)).toEqual([
            'SAME_TOOL',
            'only_a',
            'only_b',
        ]);
    });
});
