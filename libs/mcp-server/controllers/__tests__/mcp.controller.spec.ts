import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';

jest.mock('../../services/mcp-server.service', () => ({
    McpServerService: class {},
}));

jest.mock('../../services/mcp-manager.service', () => ({
    MCPManagerService: class {},
}));

jest.mock('../../services/github-issues-mcp-server.service', () => ({
    GithubIssuesMcpServerService: class {},
}));

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

import { McpController } from '../mcp.controller';
import { GithubIssuesMcpController } from '../github-issues-mcp.controller';
import { McpEnabledGuard } from '../../guards/mcp-enabled.guard';

function makeResponse(accept?: string) {
    const response = {
        req: {
            headers: accept ? { accept } : {},
        },
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
    };

    return response as any;
}

describe('McpController', () => {
    let controller: McpController;
    let mcpServerService: {
        handleRequest: jest.Mock;
    };

    beforeEach(() => {
        mcpServerService = {
            handleRequest: jest.fn().mockResolvedValue(undefined),
        };

        controller = new McpController(mcpServerService as any);
    });

    it('delegates POST requests directly to the stateless service', async () => {
        const response = makeResponse('application/json, text/event-stream');
        const body = {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                clientInfo: {
                    name: 'internal-client',
                    version: '1.0.0',
                },
            },
        };

        await controller.handleClientRequest(body, response);

        expect(mcpServerService.handleRequest).toHaveBeenCalledWith(
            body,
            response,
        );
        expect(response.setHeader).toHaveBeenCalledWith(
            'Access-Control-Expose-Headers',
            'Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        );
    });

    it('returns 405 for GET in stateless mode', async () => {
        const response = makeResponse('text/event-stream');

        await controller.handleServerNotifications(response);

        expect(response.status).toHaveBeenCalledWith(
            HttpStatus.METHOD_NOT_ALLOWED,
        );
        expect(response.setHeader).toHaveBeenCalledWith('Allow', 'POST');
        expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: 'Method not allowed.',
                }),
            }),
        );
    });

    it('returns 405 for DELETE in stateless mode', async () => {
        const response = makeResponse();

        await controller.handleSessionTermination(response);

        expect(response.status).toHaveBeenCalledWith(
            HttpStatus.METHOD_NOT_ALLOWED,
        );
        expect(response.setHeader).toHaveBeenCalledWith('Allow', 'POST');
        expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: 'Method not allowed.',
                }),
            }),
        );
    });

    it('keeps only the MCP enabled guard at controller level', () => {
        const guards =
            Reflect.getMetadata(GUARDS_METADATA, McpController) ?? [];

        expect(guards).toEqual([McpEnabledGuard]);
    });
});

describe('GithubIssuesMcpController', () => {
    let controller: GithubIssuesMcpController;
    let mcpServerService: {
        handleRequest: jest.Mock;
    };

    beforeEach(() => {
        mcpServerService = {
            handleRequest: jest.fn().mockResolvedValue(undefined),
        };

        controller = new GithubIssuesMcpController(mcpServerService as any);
    });

    it('delegates POST requests directly to the stateless service', async () => {
        const response = makeResponse('application/json, text/event-stream');
        const body = {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
        };

        await controller.handleClientRequest(body, response);

        expect(mcpServerService.handleRequest).toHaveBeenCalledWith(
            body,
            response,
        );
        expect(response.setHeader).toHaveBeenCalledWith(
            'Access-Control-Expose-Headers',
            'Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        );
    });

    it('returns 405 for GET in stateless mode', async () => {
        const response = makeResponse('text/event-stream');

        await controller.handleServerNotifications(response);

        expect(response.status).toHaveBeenCalledWith(
            HttpStatus.METHOD_NOT_ALLOWED,
        );
        expect(response.setHeader).toHaveBeenCalledWith('Allow', 'POST');
        expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: 'Method not allowed.',
                }),
            }),
        );
    });

    it('returns 405 for DELETE in stateless mode', async () => {
        const response = makeResponse();

        await controller.handleSessionTermination(response);

        expect(response.status).toHaveBeenCalledWith(
            HttpStatus.METHOD_NOT_ALLOWED,
        );
        expect(response.setHeader).toHaveBeenCalledWith('Allow', 'POST');
        expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({
                error: expect.objectContaining({
                    message: 'Method not allowed.',
                }),
            }),
        );
    });

    it('keeps only the MCP enabled guard at controller level', () => {
        const guards =
            Reflect.getMetadata(GUARDS_METADATA, GithubIssuesMcpController) ??
            [];

        expect(guards).toEqual([McpEnabledGuard]);
    });
});
