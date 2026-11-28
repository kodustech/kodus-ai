import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Response } from 'express';

import { createLogger } from '@libs/core/log/logger';

import { ENV_TOOLS, EnvTools } from '../tools/env.tools';
import { extractMcpRequestMetadata } from '../utils/mcp-protocol.utils';

/**
 * /mcp/env in the same stateless model as the other MCP endpoints: a fresh
 * server and transport per POST, no session kept. Answers plain JSON (not
 * SSE), so the CLI and simple clients read it without a stream parser.
 */
@Injectable()
export class EnvMcpServerService {
    private readonly logger = createLogger(EnvMcpServerService.name);

    constructor(private readonly tools: EnvTools) {}

    create() {
        const server = new McpServer(
            { name: 'kody-runtime-env', version: '1.0.0' },
            { capabilities: { tools: {} } },
        );
        for (const tool of ENV_TOOLS) {
            server.registerTool(
                tool.name,
                {
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                    annotations: tool.annotations,
                },
                (args: Record<string, unknown>, extra: unknown) =>
                    this.tools.call(tool, args, extra),
            );
        }
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        return { server, transport };
    }

    async handleRequest(body: unknown, res: Response): Promise<void> {
        const startedAt = Date.now();
        const { server, transport } = this.create();
        await server.connect(transport);
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            void transport.close();
            void server.close();
        };
        res.once('close', close);
        res.once('finish', () => {
            this.logger.log({
                message: 'MCP env request completed',
                context: EnvMcpServerService.name,
                metadata: {
                    statusCode: res.statusCode,
                    latencyMs: Date.now() - startedAt,
                    ...extractMcpRequestMetadata(body),
                },
            });
            close();
        });
        try {
            await transport.handleRequest(res.req, res, body);
        } catch (error) {
            close();
            throw error;
        }
    }
}
