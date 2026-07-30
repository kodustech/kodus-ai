import { createLogger } from '@libs/core/log/logger';
import {
    EngineTool,
    MCPAdapter,
    MCPAdapterConfig,
    MCPPromptWithServer,
    MCPResourceWithServer,
    MCPTool,
} from './types';
import { MCPRegistry } from './registry';
import { mcpToolsToEngineTools } from './tools';
/**
 * Create an MCP adapter for Kodus Flow
 *
 * @example
 * ```typescript
 * const mcpAdapter = createMCPAdapter({
 *   servers: [
 *     {
 *       name: 'filesystem',
 *       type: 'http',
 *       url: 'http://localhost:3000',
 *     },
 *     {
 *       name: 'github',
 *       type: 'http',
 *       url: 'http://localhost:3001',
 *       headers: {
 *         Authorization: `Bearer ${process.env.GITHUB_TOKEN}`
 *       }
 *     }
 *   ],
 *   // Tool filtering
 *   allowedTools: {
 *     names: ['read_file', 'write_file'],
 *     servers: ['filesystem'],
 *   },
 *   blockedTools: {
 *     names: ['dangerous_tool'],
 *     patterns: [/delete/],
 *   },
 *   // Error handling
 *   onError: (error, serverName) => {
 *     console.error(`MCP server ${serverName} error:`, error);
 *   }
 * });
 *
 * // Connect all servers
 * await mcpAdapter.connect();
 *
 * // Use with an agent
 * const agent = createAgent({
 *   tools: await mcpAdapter.getTools(),
 * });
 * ```
 */
export function createMCPAdapter(config: MCPAdapterConfig): MCPAdapter {
    const logger = createLogger('createMCPAdapter');

    let isConnected = false;
    let ensurePromise: Promise<void> | null = null;
    let toolIndexDirty = true;

    const registry = new MCPRegistry({
        defaultTimeout: config.defaultTimeout,
        maxRetries: config.maxRetries,
        onToolsChanged: (serverName: string) => {
            toolIndexDirty = true;
            logger.debug({
                message: 'Tool index marked dirty due to change',
                context: 'createMCPAdapter',

                metadata: {
                    serverName,
                },
            });
        },
    });

    const adapter: MCPAdapter = {
        /**
         * Connect to all configured MCP servers
         */
        async connect(): Promise<void> {
            if (isConnected) {
                await this.disconnect();
            }

            if (!config.servers.length) {
                isConnected = false;
                throw new Error(
                    'No MCP servers configured. Unable to establish MCP connection.',
                );
            }

            const promises = config.servers.map((server) =>
                registry.register(server).catch((error) => {
                    if (config.onError) {
                        config.onError(error, server.name);
                    }
                    throw error;
                }),
            );

            const results = await Promise.allSettled(promises);

            const rejected = results.filter(
                (result) => result.status === 'rejected',
            );
            const successful = results.filter(
                (result) => result.status === 'fulfilled',
            );

            if (rejected.length > 0) {
                logger.warn({
                    message: `${rejected.length} MCP server(s) failed to connect.`,
                    context: 'createMCPAdapter',
                });

                for (const result of rejected) {
                    logger.error({
                        message: 'MCP connection error:',
                        context: 'createMCPAdapter',
                        error: result.reason,
                    });
                }
            }

            if (successful.length === 0) {
                isConnected = false;
                throw new Error(
                    'Failed to connect to any MCP server. Check MCP server health and credentials.',
                );
            }

            isConnected = true;
        },

        /**
         * Disconnect from all MCP servers
         */
        async disconnect(): Promise<void> {
            if (!isConnected) {
                return;
            }

            try {
                registry.destroy();
            } catch {
                /* ignore registry destroy errors */
            } finally {
                isConnected = false;
            }
        },

        /**
         * Get all tools as engine-compatible tools
         */
        async getTools(): Promise<MCPTool[]> {
            if (!isConnected) {
                throw new Error(
                    'MCP adapter not connected. Call connect() first.',
                );
            }

            await this.ensureConnection();

            const mcpTools = await registry.listAllTools();
            const engineTools = mcpToolsToEngineTools(mcpTools);

            return engineTools.map((tool: EngineTool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool?.inputSchema,
                outputSchema: tool?.outputSchema,
                annotations: tool?.annotations,
                title: tool?.title,
                execute: async (args: unknown, _ctx: unknown) => {
                    return registry.executeTool(
                        tool.name,
                        args as Record<string, unknown>,
                    );
                },
            }));
        },

        /**
         * Check if a tool exists
         */
        async hasTool(name: string): Promise<boolean> {
            if (!isConnected) {
                return false;
            }

            try {
                await this.ensureConnection();
                const tools = await registry.listAllTools();
                return tools.some((tool) => tool.name === name);
            } catch {
                return false;
            }
        },

        /**
         * List all resources from all servers
         */
        async listResources(): Promise<MCPResourceWithServer[]> {
            if (!isConnected) {
                throw new Error(
                    'MCP adapter not connected. Call connect() first.',
                );
            }

            // TODO: Implement resource listing with health checks
            return [];
        },

        /**
         * Read a resource
         */
        async readResource(
            _uri: string,
            _serverName?: string,
        ): Promise<unknown> {
            if (!isConnected) {
                throw new Error(
                    'MCP adapter not connected. Call connect() first.',
                );
            }

            // TODO: Implement resource reading with health checks
            throw new Error('Resource reading not implemented');
        },

        /**
         * List all prompts from all servers
         */
        async listPrompts(): Promise<MCPPromptWithServer[]> {
            if (!isConnected) {
                throw new Error(
                    'MCP adapter not connected. Call connect() first.',
                );
            }

            // TODO: Implement prompt listing with health checks
            return [];
        },

        /**
         * Get a prompt
         */
        async getPrompt(
            _name: string,
            _args?: Record<string, string>,
            _serverName?: string,
        ): Promise<unknown> {
            if (!isConnected) {
                throw new Error(
                    'MCP adapter not connected. Call connect() first.',
                );
            }

            // TODO: Implement prompt getting with health checks
            throw new Error('Prompt getting not implemented');
        },

        /**
         * Execute a tool directly
         */
        async executeTool(
            name: string,
            args?: Record<string, unknown>,
            serverName?: string,
        ) {
            if (!isConnected) {
                throw new Error(
                    'MCP adapter not connected. Call connect() first.',
                );
            }

            await this.ensureConnection();

            // Since we removed server prefix, use the name directly
            // If serverName is provided, use it; otherwise let registry find the tool
            return registry.executeTool(name, args, serverName);
        },

        /**
         * Ensure connection is fresh and working
         */
        async ensureConnection(): Promise<void> {
            if (ensurePromise) {
                await ensurePromise;
                return;
            }

            ensurePromise = (async () => {
                try {
                    if (!isConnected) {
                        await this.connect();
                        await registry.listAllTools();
                        toolIndexDirty = false;
                        return;
                    }

                    if (toolIndexDirty) {
                        await registry.listAllTools();
                        toolIndexDirty = false;
                        return;
                    }

                    try {
                        await registry.listAllTools();
                        toolIndexDirty = false;
                    } catch (error) {
                        logger.warn({
                            message:
                                'Failed to refresh tool list, reconnecting',
                            context: 'createMCPAdapter',

                            error: error as Error,
                        });
                        await this.disconnect();
                        await this.connect();
                        await registry.listAllTools();
                        toolIndexDirty = false;
                    }
                } finally {
                    ensurePromise = null;
                }
            })();

            await ensurePromise;
        },

        getMetrics(): Record<string, unknown> {
            const metrics: Record<string, unknown> = {};

            return metrics;
        },

        getRegistry(): MCPRegistry {
            return registry;
        },
    };

    return adapter;
}

export { MCPRegistry } from './registry';
export { SpecCompliantMCPClient as MCPClient } from './client';
export {
    SessionManager,
    type ISessionManager,
    type Session,
} from './session-manager';
export {
    JWTValidator,
    type JWTOptions,
    type JWTClaims,
} from './jwt-validator';

// MCP provider/tool key helpers (used by mcp-tool-metadata.service).
export {
    normalizeProviderKey,
    normalizeToolKey,
    markProviderHasMetadata,
    registerProviderAliases,
    registerToolAliases,
    resolveCanonicalProvider,
    resolveCanonicalTool,
} from './mcp-utils';

// Public MCP types — the consumers import these (previously from the legacy flow engine).
export type {
    MCPAdapter,
    MCPAdapterConfig,
    MCPServerConfig,
    MCPTool,
    MCPToolRaw,
    MCPToolWithServer,
    MCPToolRawWithServer,
    MCPResource,
    MCPResourceWithServer,
    MCPPrompt,
    MCPPromptWithServer,
    MCPRegistryOptions,
    TransportType,
} from './types';
