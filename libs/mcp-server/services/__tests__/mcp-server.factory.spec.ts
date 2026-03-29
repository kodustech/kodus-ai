const loggerMock = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

const toShapeMock = jest.fn((schema) => schema);

jest.mock('@kodus/flow', () => ({
    createLogger: () => loggerMock,
}));

jest.mock('../../types/mcp-tool.interface', () => ({
    toShape: (schema: unknown) => toShapeMock(schema),
}));

describe('McpServerFactory', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('caches tool metadata so schemas are transformed only once', async () => {
        const tool = {
            name: 'KODUS_LIST_REPOSITORIES',
            description: 'List repositories',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
            execute: jest.fn().mockResolvedValue({ content: [] }),
        };

        const { McpServerFactory } = await import('../mcp-server.factory');

        const factory = new McpServerFactory(
            { getAllTools: jest.fn().mockReturnValue([tool]) } as any,
            { getAllTools: jest.fn().mockReturnValue([]) } as any,
            { getAllTools: jest.fn().mockReturnValue([]) } as any,
        );

        const first = await factory.create();
        const second = await factory.create();

        expect(toShapeMock).toHaveBeenCalledTimes(2);
        expect(first.server).toBeDefined();
        expect(second.server).toBeDefined();

        await first.transport.close();
        await first.server.close();
        await second.transport.close();
        await second.server.close();
    });

    it('fails fast when a tool input schema cannot be converted', async () => {
        toShapeMock.mockImplementationOnce(() => undefined);

        const tool = {
            name: 'KODUS_LIST_REPOSITORIES',
            description: 'List repositories',
            inputSchema: { type: 'object', properties: {} },
            outputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
            execute: jest.fn().mockResolvedValue({ content: [] }),
        };

        const { McpServerFactory } = await import('../mcp-server.factory');

        const factory = new McpServerFactory(
            { getAllTools: jest.fn().mockReturnValue([tool]) } as any,
            { getAllTools: jest.fn().mockReturnValue([]) } as any,
            { getAllTools: jest.fn().mockReturnValue([]) } as any,
        );

        await expect(factory.create()).rejects.toThrow(
            'Invalid input schema for MCP tool: KODUS_LIST_REPOSITORIES',
        );
    });
});
