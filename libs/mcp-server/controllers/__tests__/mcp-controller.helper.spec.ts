import { HttpStatus } from '@nestjs/common';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

import {
    handleStatelessMcpPost,
    handleUnsupportedStatelessMcpMethod,
} from '../mcp-controller.helper';

function makeResponse() {
    return {
        headersSent: false,
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
    } as any;
}

describe('mcp-controller.helper', () => {
    it('delegates a stateless POST request and applies MCP response headers', async () => {
        const res = makeResponse();
        const handler = jest.fn().mockResolvedValue(undefined);
        const body = { jsonrpc: '2.0', id: 1, method: 'initialize' };

        await handleStatelessMcpPost({
            body,
            res,
            handler,
            errorContext: 'TestMcpController',
            errorMessage: 'Error handling MCP request',
            logger: {
                error: jest.fn(),
            } as any,
        });

        expect(handler).toHaveBeenCalledWith(body, res);
        expect(res.setHeader).toHaveBeenCalledWith(
            'Access-Control-Expose-Headers',
            'Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        );
    });

    it('returns JSON-RPC 500 when the handler throws before sending headers', async () => {
        const res = makeResponse();
        const logger = { error: jest.fn() } as any;
        const body = {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: {
                name: 'KODUS_LIST_REPOSITORIES',
                arguments: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                    password: 'should-not-be-logged',
                },
            },
        };

        await handleStatelessMcpPost({
            body,
            res,
            handler: jest.fn().mockRejectedValue(new Error('boom')),
            errorContext: 'TestMcpController',
            errorMessage: 'Error handling MCP request',
            logger,
        });

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    jsonrpcMethod: 'tools/call',
                    toolName: 'KODUS_LIST_REPOSITORIES',
                    organizationId: 'org-1',
                    teamId: 'team-1',
                }),
            }),
        );
        expect(logger.error.mock.calls[0][0].metadata).not.toHaveProperty(
            'body',
        );
        expect(res.status).toHaveBeenCalledWith(
            HttpStatus.INTERNAL_SERVER_ERROR,
        );
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 7,
                error: expect.objectContaining({
                    message: 'Internal error',
                }),
            }),
        );
    });

    it('does not try to rewrite the response if headers were already sent', async () => {
        const res = makeResponse();
        res.headersSent = true;

        await handleStatelessMcpPost({
            body: { jsonrpc: '2.0', id: 9, method: 'tools/list' },
            res,
            handler: jest.fn().mockRejectedValue(new Error('boom')),
            errorContext: 'TestMcpController',
            errorMessage: 'Error handling MCP request',
            logger: {
                error: jest.fn(),
            } as any,
        });

        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
    });

    it('returns 405 with Allow POST for unsupported stateless methods', () => {
        const res = makeResponse();

        handleUnsupportedStatelessMcpMethod(res);

        expect(res.setHeader).toHaveBeenCalledWith(
            'Access-Control-Expose-Headers',
            'Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        );
        expect(res.setHeader).toHaveBeenCalledWith('Allow', 'POST');
        expect(res.status).toHaveBeenCalledWith(HttpStatus.METHOD_NOT_ALLOWED);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: 'Method not allowed.',
                }),
            }),
        );
    });
});
