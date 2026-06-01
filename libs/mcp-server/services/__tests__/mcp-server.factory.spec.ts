import { z } from 'zod';

const loggerMock = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

const emptyZodShape = { __placeholder: z.string().optional() };
const toShapeMock = jest.fn(() => emptyZodShape);

const mockRegisterTool = jest.fn();
const mockConnect = jest.fn();
const mockClose = jest.fn();

jest.mock('@kodus/flow', () => ({
    createLogger: () => loggerMock,
}));

jest.mock('../../types/mcp-tool.interface', () => ({
    toShape: (schema: unknown) => toShapeMock(schema),
}));

jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
    McpServer: jest.fn().mockImplementation(() => ({
        registerTool: mockRegisterTool,
        connect: mockConnect,
        close: mockClose,
    })),
}));

jest.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
    StreamableHTTPServerTransport: jest.fn().mockImplementation(() => ({
        close: jest.fn(),
    })),
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

        // toShape is called once per schema field (input + output) and cached for the second create()
        expect(toShapeMock).toHaveBeenCalledTimes(2);
        expect(first.server).toBeDefined();
        expect(second.server).toBeDefined();
        // registerTool should be called once per create()
        expect(mockRegisterTool).toHaveBeenCalledTimes(2);
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
