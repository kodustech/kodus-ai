import { MCPRegistry } from './registry';

describe('MCPRegistry.executeTool', () => {
    function registryWith(client: any) {
        const registry = new MCPRegistry();
        (registry as any).clients.set('Billing', client);
        (registry as any).toolIndex.set('get_invoice', new Set(['Billing']));
        return registry;
    }

    it('says the server failed, not that the tool is missing, when its server errors', async () => {
        const registry = registryWith({
            executeTool: jest
                .fn()
                .mockRejectedValue(new Error('connect ECONNREFUSED')),
            listTools: jest
                .fn()
                .mockRejectedValue(new Error('connect ECONNREFUSED')),
        });
        await expect(registry.executeTool('get_invoice', {})).rejects.toThrow(
            'MCP server Billing is unavailable (connect ECONNREFUSED)',
        );
    });

    it('still reports a tool no server has', async () => {
        const registry = new MCPRegistry();
        await expect(registry.executeTool('nope', {})).rejects.toThrow(
            'Tool nope not found in any registered MCP server',
        );
    });
});
