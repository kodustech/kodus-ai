import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { CodeManagementTools, KodyIssuesTools, KodyRulesTools } from '../tools';
import { toShape } from '../types/mcp-tool.interface';
import { executeLoggedTool } from '../utils/mcp-protocol.utils';

export interface StatelessMcpRequestHandler {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
}

type RegisteredToolDefinition = {
    name: string;
    config: {
        description: string;
        inputSchema: ReturnType<typeof toShape>;
        outputSchema: ReturnType<typeof toShape>;
        annotations: Record<string, unknown> | undefined;
    };
    execute: (
        args: Record<string, unknown>,
        extra: unknown,
    ) => Promise<CallToolResult>;
};

@Injectable()
export class McpServerFactory {
    private readonly logger = createLogger(McpServerFactory.name);
    private registeredToolsCache?: RegisteredToolDefinition[];

    constructor(
        private readonly codeManagementTools: CodeManagementTools,
        private readonly kodyRulesTools: KodyRulesTools,
        private readonly kodyIssuesTools: KodyIssuesTools,
    ) {}

    async create(): Promise<StatelessMcpRequestHandler> {
        const server = new McpServer(
            {
                name: 'kodus-code-management',
                version: '1.0.0',
            },
            {
                capabilities: {
                    tools: {},
                },
            },
        );

        for (const tool of this.getRegisteredTools()) {
            server.registerTool(tool.name, tool.config, tool.execute);
        }

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });

        await server.connect(transport);

        return {
            server,
            transport,
        };
    }

    getAvailableToolsCount(): number {
        return this.getRegisteredTools().length;
    }

    private getRegisteredTools(): RegisteredToolDefinition[] {
        if (this.registeredToolsCache) {
            return this.registeredToolsCache;
        }

        const allTools = [
            ...this.codeManagementTools.getAllTools(),
            ...this.kodyRulesTools.getAllTools(),
            ...this.kodyIssuesTools.getAllTools(),
        ];

        this.registeredToolsCache = allTools.map((tool) => {
            const inputSchema = toShape(tool.inputSchema);
            if (!inputSchema) {
                throw new Error(
                    `Invalid input schema for MCP tool: ${tool.name}`,
                );
            }

            return {
                name: tool.name,
                config: {
                    description: tool.description,
                    inputSchema,
                    outputSchema: toShape(tool.outputSchema),
                    annotations: tool?.annotations,
                },
                execute: async (
                    args: Record<string, unknown>,
                    extra: unknown,
                ) =>
                    executeLoggedTool(
                        tool.name,
                        tool.execute as (
                            toolArgs: Record<string, unknown>,
                            toolExtra: unknown,
                        ) => Promise<CallToolResult>,
                        args,
                        extra,
                        this.logger,
                    ),
            };
        });

        return this.registeredToolsCache;
    }
}
