const githubIssuesLoggerMock = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => githubIssuesLoggerMock,
}));

describe('GithubIssuesMcpServerService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('logs canonical metadata for request completion', async () => {
        const eventHandlers = new Map<string, () => void>();
        const transport = {
            handleRequest: jest.fn().mockImplementation(async (_req, res) => {
                res.statusCode = 200;
                eventHandlers.get('finish')?.();
            }),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const server = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        const { GithubIssuesMcpServerService } =
            await import('../github-issues-mcp-server.service');

        const service = new GithubIssuesMcpServerService({
            create: jest.fn().mockResolvedValue({ server, transport }),
            getAvailableToolsCount: jest.fn().mockReturnValue(2),
        } as any);

        const req = {
            method: 'POST',
            url: '/mcp/github-issues',
            originalUrl: '/mcp/github-issues',
        };
        const res = {
            req,
            statusCode: 0,
            once: jest.fn((event: string, cb: () => void) => {
                eventHandlers.set(event, cb);
                return res;
            }),
        } as any;

        await service.handleRequest(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'KODUS_GET_GITHUB_ISSUE',
                    arguments: {
                        organizationId: 'org-1',
                    },
                },
            },
            res,
        );

        expect(githubIssuesLoggerMock.log).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                message: 'GitHub Issues MCP stateless request received',
                metadata: expect.objectContaining({
                    path: '/mcp/github-issues',
                    jsonrpcMethod: 'tools/call',
                    toolName: 'KODUS_GET_GITHUB_ISSUE',
                    organizationId: 'org-1',
                }),
            }),
        );
        expect(githubIssuesLoggerMock.log).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                message: 'GitHub Issues MCP stateless request completed',
                metadata: expect.objectContaining({
                    statusCode: 200,
                    jsonrpcMethod: 'tools/call',
                    toolName: 'KODUS_GET_GITHUB_ISSUE',
                    organizationId: 'org-1',
                }),
            }),
        );
    });

    it('logs failures and rethrows when transport handling fails', async () => {
        const transport = {
            handleRequest: jest
                .fn()
                .mockRejectedValue(new Error('transport failure')),
            close: jest.fn().mockResolvedValue(undefined),
        };
        const server = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        const { GithubIssuesMcpServerService } =
            await import('../github-issues-mcp-server.service');

        const service = new GithubIssuesMcpServerService({
            create: jest.fn().mockResolvedValue({ server, transport }),
            getAvailableToolsCount: jest.fn().mockReturnValue(2),
        } as any);

        const req = {
            method: 'POST',
            url: '/mcp/github-issues',
            originalUrl: '/mcp/github-issues',
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
                    method: 'tools/list',
                },
                res,
            ),
        ).rejects.toThrow('transport failure');

        expect(githubIssuesLoggerMock.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'GitHub Issues MCP stateless request failed',
                metadata: expect.objectContaining({
                    path: '/mcp/github-issues',
                    jsonrpcMethod: 'tools/list',
                }),
            }),
        );
        expect(transport.close).toHaveBeenCalledTimes(1);
        expect(server.close).toHaveBeenCalledTimes(1);
    });
});
