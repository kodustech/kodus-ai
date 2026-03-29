import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import { hostname } from 'node:os';

import { extractMcpRequestMetadata } from '../utils/mcp-protocol.utils';
import { McpServerFactory } from './mcp-server.factory';

@Injectable()
export class McpServerService {
    private readonly logger = createLogger(McpServerService.name);
    private readonly instanceId = hostname();

    constructor(private readonly factory: McpServerFactory) {}

    async handleRequest(body: any, res: Response): Promise<void> {
        const startedAt = Date.now();
        const { server, transport } = await this.factory.create();
        const requestMetadata = extractMcpRequestMetadata(body);
        let isClosed = false;
        let isFinished = false;

        const closeTransport = () => {
            if (isClosed) {
                return;
            }

            isClosed = true;
            void transport.close();
            void server.close();
        };

        this.logger.log({
            message: 'MCP stateless request received',
            context: McpServerService.name,
            metadata: {
                method: res.req.method,
                path: res.req.originalUrl ?? res.req.url,
                instanceId: this.instanceId,
                ...requestMetadata,
            },
        });

        res.once('close', closeTransport);
        res.once('close', () => {
            if (isFinished) {
                return;
            }

            this.logger.warn({
                message: 'MCP stateless request aborted',
                context: McpServerService.name,
                metadata: {
                    method: res.req.method,
                    path: res.req.originalUrl ?? res.req.url,
                    statusCode: res.statusCode,
                    latencyMs: Date.now() - startedAt,
                    instanceId: this.instanceId,
                    ...requestMetadata,
                },
            });
        });
        res.once('finish', () => {
            isFinished = true;
            this.logger.log({
                message: 'MCP stateless request completed',
                context: McpServerService.name,
                metadata: {
                    method: res.req.method,
                    path: res.req.originalUrl ?? res.req.url,
                    statusCode: res.statusCode,
                    latencyMs: Date.now() - startedAt,
                    instanceId: this.instanceId,
                    ...requestMetadata,
                },
            });

            closeTransport();
        });

        try {
            await transport.handleRequest(res.req, res, body);
        } catch (error) {
            this.logger.error({
                message: 'MCP stateless request failed',
                context: McpServerService.name,
                error: error instanceof Error ? error : undefined,
                metadata: {
                    method: res.req.method,
                    path: res.req.originalUrl ?? res.req.url,
                    statusCode: res.statusCode,
                    latencyMs: Date.now() - startedAt,
                    instanceId: this.instanceId,
                    ...requestMetadata,
                },
            });
            closeTransport();
            throw error;
        }
    }

    getActiveSessionCount(): number {
        return 0;
    }

    getAvailableToolsCount(): number {
        return this.factory.getAvailableToolsCount();
    }

    async cleanup(): Promise<void> {
        this.logger.log({
            message: 'No MCP session cleanup needed in stateless mode',
            context: McpServerService.name,
        });
    }
}
