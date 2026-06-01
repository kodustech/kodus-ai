import { SpecCompliantMCPClient } from './client.js';
import { createLogger } from '../../observability/index.js';
import {
    MCPClientConfig,
    MCPRegistryOptions,
    MCPServerConfig,
    MCPToolRawWithServer,
    TransportType,
} from '../../core/types/allTypes.js';

export class MCPRegistry {
    private clients = new Map<string, SpecCompliantMCPClient>();
    private pending = new Map<string, Promise<void>>();
    private options: MCPRegistryOptions & {
        defaultTimeout: number;
        maxRetries: number;
    };
    private logger = createLogger('MCPRegistry');
    private toolIndex = new Map<string, Set<string>>();

    constructor(options: MCPRegistryOptions = {}) {
        const { defaultTimeout, maxRetries, ...rest } = options;

        this.options = {
            defaultTimeout:
                typeof defaultTimeout === 'number' ? defaultTimeout : 30000,
            maxRetries: typeof maxRetries === 'number' ? maxRetries : 3,
            ...rest,
            onToolsChanged: options.onToolsChanged,
        };

        this.logger.log({
            message: 'MCPRegistry initialized',
            context: this.constructor.name,
        });
    }

    /**
     * Registra um servidor MCP
     */
    async register(config: MCPServerConfig): Promise<void> {
        // Verifica se já está registrando
        if (this.pending.has(config.name)) {
            await this.pending.get(config.name);
            return;
        }

        // cria a promessa de registro e salva no map
        const job = (async () => {
            try {
                this.logger.log({
                    message: 'Registering MCP server',
                    context: this.constructor.name,

                    metadata: {
                        serverName: config.name,
                    },
                });

                // ─── 1. Normalizar tipo de transporte ───────────────────────────────
                const transportType: TransportType = config.type ?? 'http';

                // ─── 2. Montar configuração p/ SpecCompliantMCPClient ───────────────
                const clientConfig: MCPClientConfig = {
                    clientInfo: {
                        name: `mcp-registry-client-${config.name}`,
                        version: '1.0.0',
                    },
                    transport: {
                        type: transportType,
                        url: config.url, // obrigatório para http/sse/ws
                        headers: config.headers,
                        timeout: config.timeout ?? this.options.defaultTimeout,
                        retries: config.retries ?? this.options.maxRetries,
                    },
                    capabilities: {
                        roots: { listChanged: true },
                        sampling: {},
                        elicitation: {},
                    },
                    allowedTools: config.allowedTools || [],
                };

                // ─── 3. Criar & conectar cliente ───────────────────────────────────
                const client = new SpecCompliantMCPClient(clientConfig);
                await client.connect();
                this.clients.set(config.name, client);

                this.markToolsDirty(config.name);

                this.logger.log({
                    message: 'Successfully registered MCP server',
                    context: this.constructor.name,

                    metadata: {
                        serverName: config.name,
                    },
                });
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                const errorCause =
                    error instanceof Error && error.cause
                        ? (error.cause as any).message || String(error.cause)
                        : undefined;

                this.logger.error({
                    message: `Failed to register MCP server: ${errorMessage}`,
                    context: this.constructor.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: {
                        serverName: config.name,
                        serverUrl: config.url,
                        serverType: config.type,
                        errorMessage,
                        errorCause,
                        errorStack:
                            error instanceof Error
                                ? error.stack?.substring(0, 500)
                                : undefined,
                        config,
                    },
                });
                throw error;
            } finally {
                // remove promessa pendente (sucesso ou erro)
                this.pending.delete(config.name);
            }
        })();

        // salva e aguarda
        this.pending.set(config.name, job);
        await job;
    }

    /**
     * Remove um servidor MCP
     */
    async unregister(serverName: string): Promise<void> {
        const client = this.clients.get(serverName);
        if (client) {
            await client.disconnect();
            this.clients.delete(serverName);
            this.removeServerFromIndex(serverName);
            this.markToolsDirty(serverName);
        }
    }

    /**
     * Lista todas as tools
     */
    async listAllTools(): Promise<MCPToolRawWithServer[]> {
        const allTools: MCPToolRawWithServer[] = [];
        const refreshedIndex = new Map<string, Set<string>>();

        this.logger.log({
            message: 'Listing all tools from MCP registry',
            context: this.constructor.name,

            metadata: {
                totalClients: this.clients.size,
            },
        });

        // Lista todas as tools
        for (const [serverName, client] of this.clients) {
            try {
                this.logger.debug({
                    message: 'Listing tools from server',
                    context: this.constructor.name,

                    metadata: {
                        serverName,
                    },
                });

                // Check if client is still connected
                if (!client.isConnected()) {
                    this.logger.warn({
                        message:
                            'Client not connected, attempting to reconnect',
                        context: this.constructor.name,

                        metadata: {
                            serverName,
                        },
                    });
                    try {
                        await client.connect();
                    } catch (reconnectError) {
                        const reconnectMsg =
                            reconnectError instanceof Error
                                ? reconnectError.message
                                : String(reconnectError);
                        const reconnectCause =
                            reconnectError instanceof Error &&
                            reconnectError.cause
                                ? (reconnectError.cause as any).message ||
                                  String(reconnectError.cause)
                                : undefined;

                        this.logger.error({
                            message: `Failed to reconnect to server: ${reconnectMsg}`,
                            context: this.constructor.name,

                            error:
                                reconnectError instanceof Error
                                    ? reconnectError
                                    : undefined,

                            metadata: {
                                serverName,
                                errorMessage: reconnectMsg,
                                errorCause: reconnectCause,
                                errorStack:
                                    reconnectError instanceof Error
                                        ? reconnectError.stack?.substring(
                                              0,
                                              500,
                                          )
                                        : undefined,
                            },
                        });
                        continue; // Skip this server
                    }
                }

                const tools = await client.listTools();
                this.logger.debug({
                    message: 'Received tools from server',
                    context: this.constructor.name,

                    metadata: {
                        serverName,
                        toolCount: tools.length,
                        toolNames: tools.map((t) => t.name),
                    },
                });

                for (const tool of tools) {
                    // ✅ ADDED: Validate tool structure before processing
                    if (!tool || typeof tool !== 'object') {
                        this.logger.warn({
                            message: 'Invalid tool structure received',
                            context: this.constructor.name,

                            metadata: {
                                serverName,
                                tool,
                            },
                        });
                        continue;
                    }

                    // ✅ ADDED: Validate tool name
                    if (!tool.name || typeof tool.name !== 'string') {
                        this.logger.warn({
                            message: 'Invalid tool name received',
                            context: this.constructor.name,

                            metadata: {
                                serverName,
                                tool,
                            },
                        });
                        continue;
                    }

                    // ✅ ADDED: Validate tool schema
                    if (!tool.inputSchema) {
                        this.logger.warn({
                            message: 'Tool missing inputSchema',
                            context: this.constructor.name,

                            metadata: {
                                serverName,
                                toolName: tool.name,
                            },
                        });
                        // Use fallback schema
                        tool.inputSchema = { type: 'object', properties: {} };
                    }

                    // ✅ ADDED: Log tool metadata for debugging
                    this.logger.debug({
                        message: 'Processing MCP tool',
                        context: this.constructor.name,

                        metadata: {
                            serverName,
                            toolName: tool.name,
                            hasTitle: !!tool.title,
                            hasDescription: !!tool.description,
                            hasOutputSchema: !!tool.outputSchema,
                            hasAnnotations: !!tool.annotations,
                        },
                    });

                    if (!refreshedIndex.has(tool.name)) {
                        refreshedIndex.set(tool.name, new Set());
                    }
                    refreshedIndex.get(tool.name)?.add(serverName);

                    allTools.push({
                        ...tool,
                        serverName,
                    });
                }
            } catch (error) {
                this.logger.error({
                    message: 'Error listing tools from server',
                    context: this.constructor.name,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),

                    metadata: {
                        serverName,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        errorName:
                            error instanceof Error ? error.name : 'Unknown',
                        errorStack:
                            error instanceof Error ? error.stack : undefined,
                    },
                });

                // ✅ ADDED: Continue processing other servers instead of breaking
                // This ensures one bad server doesn't break the entire registry
                continue;
            }
        }

        this.logger.log({
            message: 'Finished listing tools',
            context: this.constructor.name,

            metadata: {
                totalToolsFound: allTools.length,

                toolsByServer: allTools.reduce(
                    (acc, tool) => {
                        if (tool.serverName) {
                            acc[tool.serverName] =
                                (acc[tool.serverName] || 0) + 1;
                        }
                        return acc;
                    },
                    {} as Record<string, number>,
                ),
            },
        });

        this.toolIndex = refreshedIndex;
        this.options.onToolsChanged?.('all');

        return allTools;
    }

    /**
     * Executa tool
     */
    async executeTool(
        toolName: string,
        args?: Record<string, unknown>,
        serverName?: string,
    ): Promise<unknown> {
        if (serverName) {
            const client = this.resolveClientByAlias(serverName);

            if (!client) {
                throw new Error(`MCP server ${serverName} not found`);
            }

            return client.executeTool(toolName, args);
        }

        // Tenta encontrar tool em qualquer servidor
        let candidateServers = this.toolIndex.get(toolName);

        if (!candidateServers || candidateServers.size === 0) {
            // refresh index to ensure we have latest mapping
            await this.listAllTools();
            candidateServers = this.toolIndex.get(toolName);
        }

        if (candidateServers && candidateServers.size > 0) {
            for (const candidate of candidateServers) {
                const client = this.clients.get(candidate);
                if (!client) {
                    continue;
                }
                try {
                    return await client.executeTool(toolName, args);
                } catch (error) {
                    const execErrMsg =
                        error instanceof Error ? error.message : String(error);
                    this.logger.warn({
                        message: `Failed to execute tool on server: ${execErrMsg}`,
                        context: this.constructor.name,

                        error: error as Error,

                        metadata: {
                            serverName: candidate,
                            toolName,
                            errorMessage: execErrMsg,
                            errorCause:
                                error instanceof Error && error.cause
                                    ? (error.cause as any).message ||
                                      String(error.cause)
                                    : undefined,
                        },
                    });
                }
            }
        }

        // Fallback legacy behaviour
        for (const client of this.clients.values()) {
            try {
                const tools = await client.listTools();

                if (tools.some((tool) => tool.name === toolName)) {
                    return client.executeTool(toolName, args);
                }
            } catch {
                /* ignora */
            }
        }
        throw new Error(
            `Tool ${toolName} not found in any registered MCP server`,
        );
    }

    /**
     * Limpa recursos
     */
    destroy(): void {
        // Desconecta todos os clientes
        for (const [, client] of this.clients) {
            client.disconnect().catch((error) => {
                this.logger.warn({
                    message: 'Failed to disconnect MCP client',
                    context: this.constructor.name,
                    error: error.message,
                });
            });
        }
        this.clients.clear();
        this.toolIndex.clear();
        this.options.onToolsChanged?.('destroy');
    }

    private removeServerFromIndex(serverName: string): void {
        for (const [toolName, servers] of this.toolIndex.entries()) {
            servers.delete(serverName);
            if (servers.size === 0) {
                this.toolIndex.delete(toolName);
            }
        }
    }

    private markToolsDirty(serverName: string): void {
        this.toolIndex.clear();
        this.options.onToolsChanged?.(serverName);
    }

    private resolveClientByAlias(
        serverName?: string,
    ): SpecCompliantMCPClient | undefined {
        if (!serverName) {
            return undefined;
        }

        const direct = this.clients.get(serverName);
        if (direct) {
            return direct;
        }

        const normalizedTarget = this.normalizeServerKey(serverName);
        if (!normalizedTarget) {
            return undefined;
        }

        for (const [candidate, client] of this.clients.entries()) {
            if (this.normalizeServerKey(candidate) === normalizedTarget) {
                return client;
            }
        }

        return undefined;
    }

    private normalizeServerKey(value?: string | null): string | undefined {
        if (!value || typeof value !== 'string') {
            return undefined;
        }

        const normalized = value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        if (!normalized) {
            return undefined;
        }

        return normalized.endsWith('mcp') && normalized.length > 3
            ? normalized.slice(0, -3)
            : normalized;
    }
}
