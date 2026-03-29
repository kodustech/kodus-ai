const serviceLoggerMock = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => serviceLoggerMock,
}));

describe('McpServerService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('logs canonical metadata for a stateless MCP request lifecycle', async () => {
        const eventHandlers = new Map<string, Array<() => void>>();
        const transport = {
            handleRequest: jest.fn().mockImplementation(async (_req, res) => {
                res.statusCode = 200;
                for (const handler of eventHandlers.get('finish') ?? []) {
                    handler();
                }
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const server = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        const { McpServerService } = await import('../mcp-server.service');

        const service = new McpServerService({
            create: jest.fn().mockResolvedValue({ server, transport }),
            getAvailableToolsCount: jest.fn().mockReturnValue(3),
        } as any);

        const req = {
            method: 'POST',
            url: '/mcp',
            originalUrl: '/mcp',
        };
        const res = {
            req,
            statusCode: 0,
            once: jest.fn((event: string, cb: () => void) => {
                const handlers = eventHandlers.get(event) ?? [];
                handlers.push(cb);
                eventHandlers.set(event, handlers);
                return res;
            }),
        } as any;

        await service.handleRequest(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'KODUS_LIST_REPOSITORIES',
                    arguments: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                },
            },
            res,
        );

        expect(serviceLoggerMock.log).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                message: 'MCP stateless request received',
                metadata: expect.objectContaining({
                    method: 'POST',
                    path: '/mcp',
                    jsonrpcMethod: 'tools/call',
                    toolName: 'KODUS_LIST_REPOSITORIES',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );

        expect(serviceLoggerMock.log).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                message: 'MCP stateless request completed',
                metadata: expect.objectContaining({
                    method: 'POST',
                    path: '/mcp',
                    statusCode: 200,
                    jsonrpcMethod: 'tools/call',
                    toolName: 'KODUS_LIST_REPOSITORIES',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    latencyMs: expect.any(Number),
                }),
            }),
        );
        expect(transport.close).toHaveBeenCalled();
        expect(server.close).toHaveBeenCalled();
    });

    it('logs request failure metadata and rethrows when transport handling fails', async () => {
        const transport = {
            handleRequest: jest
                .fn()
                .mockRejectedValue(new Error('transport failure')),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const server = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        const { McpServerService } = await import('../mcp-server.service');

        const service = new McpServerService({
            create: jest.fn().mockResolvedValue({ server, transport }),
            getAvailableToolsCount: jest.fn().mockReturnValue(3),
        } as any);

        const req = {
            method: 'POST',
            url: '/mcp',
            originalUrl: '/mcp',
        };
        const res = {
            req,
            statusCode: 500,
            once: jest.fn(),
        } as any;

        await expect(
            service.handleRequest(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'KODUS_LIST_REPOSITORIES',
                        arguments: {
                            organizationId: 'org-1',
                            teamId: 'team-1',
                        },
                    },
                },
                res,
            ),
        ).rejects.toThrow('transport failure');

        expect(serviceLoggerMock.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'MCP stateless request failed',
                metadata: expect.objectContaining({
                    method: 'POST',
                    path: '/mcp',
                    jsonrpcMethod: 'tools/call',
                    toolName: 'KODUS_LIST_REPOSITORIES',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );
        expect(transport.close).toHaveBeenCalledTimes(1);
        expect(server.close).toHaveBeenCalledTimes(1);
    });

    it('logs aborted requests when the response closes before finish', async () => {
        const eventHandlers = new Map<string, Array<() => void>>();
        const transport = {
            handleRequest: jest.fn().mockImplementation(async () => {
                for (const handler of eventHandlers.get('close') ?? []) {
                    handler();
                }
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const server = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        const { McpServerService } = await import('../mcp-server.service');

        const service = new McpServerService({
            create: jest.fn().mockResolvedValue({ server, transport }),
            getAvailableToolsCount: jest.fn().mockReturnValue(3),
        } as any);

        const req = {
            method: 'POST',
            url: '/mcp',
            originalUrl: '/mcp',
        };
        const res = {
            req,
            statusCode: 499,
            once: jest.fn((event: string, cb: () => void) => {
                const handlers = eventHandlers.get(event) ?? [];
                handlers.push(cb);
                eventHandlers.set(event, handlers);
                return res;
            }),
        } as any;

        await service.handleRequest(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
            },
            res,
        );

        expect(serviceLoggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'MCP stateless request aborted',
                metadata: expect.objectContaining({
                    method: 'POST',
                    path: '/mcp',
                    jsonrpcMethod: 'tools/list',
                    statusCode: 499,
                }),
            }),
        );
        expect(transport.close).toHaveBeenCalledTimes(1);
        expect(server.close).toHaveBeenCalledTimes(1);
    });
});
