import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import { hostname } from 'node:os';

import { extractMcpRequestMetadata } from '../utils/mcp-protocol.utils';
import { GithubIssuesMcpServerFactory } from './github-issues-mcp-server.factory';

@Injectable()
export class GithubIssuesMcpServerService {
    private readonly logger = createLogger(GithubIssuesMcpServerService.name);
    private readonly instanceId = hostname();

    constructor(private readonly factory: GithubIssuesMcpServerFactory) {}

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
            message: 'GitHub Issues MCP stateless request received',
            context: GithubIssuesMcpServerService.name,
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
                message: 'GitHub Issues MCP stateless request aborted',
                context: GithubIssuesMcpServerService.name,
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
                message: 'GitHub Issues MCP stateless request completed',
                context: GithubIssuesMcpServerService.name,
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
                message: 'GitHub Issues MCP stateless request failed',
                context: GithubIssuesMcpServerService.name,
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

    getAvailableToolsCount(): number {
        return this.factory.getAvailableToolsCount();
    }
}
