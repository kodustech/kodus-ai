import {
    createMCPAdapter,
    type MCPServerConfig,
    normalizeProviderKey,
    normalizeToolKey,
    markProviderHasMetadata,
} from '../mcp-adapter';
import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { MCPManagerService } from './mcp-manager.service';

export interface MCPToolMetadata {
    requiredArgs: string[];
    inputSchema?: unknown;
}

interface MetadataLoadResult {
    connections: MCPServerConfig[];
    metadata: Map<string, MCPToolMetadata>;
}

@Injectable()
export class MCPToolMetadataService {
    private readonly logger = createLogger(MCPToolMetadataService.name);
    constructor(private readonly mcpManagerService: MCPManagerService) {}

    async loadMetadataForOrganization(
        organizationAndTeamData?: OrganizationAndTeamData,
    ): Promise<MetadataLoadResult> {
        if (!organizationAndTeamData?.organizationId) {
            return this.buildEmptyResult();
        }

        const rawConnections = (await this.mcpManagerService.getConnections(
            organizationAndTeamData,
            true,
        )) as MCPServerConfig[];

        if (!rawConnections?.length) {
            return this.buildEmptyResult();
        }

        const { metadata, providersWithMetadata } =
            await this.buildMetadataFromConnections(rawConnections);

        if (!metadata.size) {
            return this.buildEmptyResult();
        }

        const filteredConnections = rawConnections.filter((connection) => {
            const canonical =
                connection.provider?.trim() ||
                connection.name?.trim() ||
                connection.url?.trim();
            if (!canonical) {
                return false;
            }
            if (providersWithMetadata.has(canonical)) {
                return true;
            }
            const normalized = normalizeProviderKey(canonical);
            return normalized ? providersWithMetadata.has(normalized) : false;
        });

        if (!filteredConnections.length) {
            return this.buildEmptyResult();
        }

        return {
            connections: filteredConnections,
            metadata,
        };
    }

    getMetadataForTool(
        map: Map<string, MCPToolMetadata>,
        providerId: string | undefined,
        toolName: string | undefined,
    ): MCPToolMetadata | undefined {
        const entry = this.resolveToolMetadata(map, providerId, toolName);
        return entry?.metadata;
    }

    resolveToolMetadata(
        map: Map<string, MCPToolMetadata>,
        providerId: string | undefined,
        toolName: string | undefined,
    ):
        | {
              providerId: string;
              toolName: string;
              metadata: MCPToolMetadata;
          }
        | undefined {
        if (!providerId || !toolName) {
            return undefined;
        }

        const trimmedProvider = providerId.trim();
        const trimmedTool = toolName.trim();

        if (!trimmedProvider || !trimmedTool) {
            return undefined;
        }

        const direct = map.get(`${trimmedProvider}|${trimmedTool}`);
        if (direct) {
            return {
                providerId: trimmedProvider,
                toolName: trimmedTool,
                metadata: direct,
            };
        }

        const normalizedProvider = normalizeProviderKey(trimmedProvider);
        const normalizedTool = normalizeToolKey(trimmedTool);

        for (const [key, metadata] of map.entries()) {
            const [candidateProvider, candidateTool] = key.split('|', 2);
            if (!candidateProvider || !candidateTool) {
                continue;
            }

            if (
                this.providersMatch(
                    candidateProvider,
                    trimmedProvider,
                    normalizedProvider,
                ) &&
                this.toolsMatch(candidateTool, trimmedTool, normalizedTool)
            ) {
                return {
                    providerId: candidateProvider,
                    toolName: candidateTool,
                    metadata,
                };
            }
        }

        return undefined;
    }

    private buildEmptyResult(): MetadataLoadResult {
        return {
            connections: [],
            metadata: new Map(),
        };
    }

    private async buildMetadataFromConnections(
        connections: MCPServerConfig[],
    ): Promise<{
        metadata: Map<string, MCPToolMetadata>;
        providersWithMetadata: Set<string>;
    }> {
        const metadataMap = new Map<string, MCPToolMetadata>();
        const providersWithMetadata = new Set<string>();

        if (!connections.length) {
            return { metadata: metadataMap, providersWithMetadata };
        }

        const adapter = createMCPAdapter({
            servers: connections,
            defaultTimeout: 60_000,
            maxRetries: 1,
            onError: (error, serverName) => {
                this.logger.warn({
                    message: 'Error synchronizing MCP tools metadata',
                    context: MCPToolMetadataService.name,
                    error,
                    metadata: { serverName },
                });
            },
        });

        try {
            await adapter.connect();
            const registry = adapter.getRegistry() as {
                listAllTools?: () => Promise<
                    Array<{
                        name: string;
                        serverName?: string;
                        inputSchema?: unknown;
                    }>
                >;
            };
            const tools =
                (await registry.listAllTools?.()) ??
                ([] as Array<{
                    name: string;
                    serverName?: string;
                    inputSchema?: unknown;
                }>);

            const providerIndex = new Map<string, string>();
            for (const connection of connections) {
                const providerId = this.resolveConnectionProviderId(connection);
                if (!providerId) continue;

                const aliases = new Set<string>();
                if (connection.name) {
                    aliases.add(connection.name.trim());
                }
                if (connection.provider) {
                    aliases.add(connection.provider.trim());
                }
                if (connection.url) {
                    aliases.add(connection.url.trim());
                }
                const metadataConn = (connection as any)?.metadata?.connection;
                if (metadataConn?.id) {
                    aliases.add(metadataConn.id.trim());
                }
                if (metadataConn?.serverName) {
                    aliases.add(metadataConn.serverName.trim());
                }

                for (const alias of aliases) {
                    if (!alias) continue;
                    providerIndex.set(alias, providerId);
                    providerIndex.set(alias.toLowerCase(), providerId);
                }
            }

            for (const tool of tools) {
                const serverName = tool.serverName ?? '';
                const trimmedServer = serverName?.trim() ?? '';
                const providerId =
                    providerIndex.get(trimmedServer) ??
                    providerIndex.get(trimmedServer.toLowerCase());
                if (!providerId) continue;

                const requiredArgs = this.extractRequiredArgs(tool.inputSchema);
                const metadata: MCPToolMetadata = {
                    requiredArgs,
                    inputSchema: tool.inputSchema,
                };

                this.registerMetadataEntry(
                    metadataMap,
                    providersWithMetadata,
                    providerId,
                    tool.name,
                    metadata,
                );
            }
        } catch (error) {
            this.logger.warn({
                message: 'Falha ao coletar metadata das ferramentas MCP',
                context: MCPToolMetadataService.name,
                error,
            });
        } finally {
            try {
                await adapter.disconnect();
            } catch {
                /* ignore */
            }
        }

        return { metadata: metadataMap, providersWithMetadata };
    }

    private resolveConnectionProviderId(
        connection: MCPServerConfig,
    ): string | undefined {
        const metadataConn = (connection as any)?.metadata?.connection;
        const candidates = [
            metadataConn?.id,
            metadataConn?.serverName,
            connection.provider,
            connection.name,
            connection.url,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim().length > 0) {
                return candidate.trim();
            }
        }

        return undefined;
    }

    private extractRequiredArgs(schema: unknown): string[] {
        if (!schema || typeof schema !== 'object') {
            return [];
        }

        const candidate = schema as Record<string, unknown>;
        const requiredRaw = candidate.required;
        const required: string[] = Array.isArray(requiredRaw)
            ? requiredRaw
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0)
            : [];

        if (required.length) {
            return required;
        }

        const properties = candidate.properties as
            | Record<string, unknown>
            | undefined;

        if (!properties) {
            return [];
        }

        const inferred: string[] = [];
        for (const [key, value] of Object.entries(properties)) {
            if (value && typeof value === 'object') {
                const requiredFlag = (value as Record<string, unknown>)
                    .required;
                if (requiredFlag === true) {
                    inferred.push(key);
                }
            }
        }
        return inferred;
    }

    private providersMatch(
        candidate: string,
        requested: string,
        requestedNormalized?: string,
    ): boolean {
        const trimmedCandidate = candidate?.trim();
        if (!trimmedCandidate) {
            return false;
        }

        if (trimmedCandidate === requested) {
            return true;
        }

        const candidateNormalized = normalizeProviderKey(trimmedCandidate);
        if (!candidateNormalized) {
            return false;
        }

        if (candidateNormalized === requestedNormalized) {
            return true;
        }

        const requestedNormalizedFallback = normalizeProviderKey(requested);
        return (
            !!requestedNormalizedFallback &&
            candidateNormalized === requestedNormalizedFallback
        );
    }

    private toolsMatch(
        candidate: string,
        requested: string,
        requestedNormalized?: string,
    ): boolean {
        const trimmedCandidate = candidate?.trim();
        if (!trimmedCandidate) {
            return false;
        }

        if (trimmedCandidate === requested) {
            return true;
        }

        const candidateNormalized = normalizeToolKey(trimmedCandidate);
        if (!candidateNormalized) {
            return false;
        }

        if (candidateNormalized === requestedNormalized) {
            return true;
        }

        const requestedNormalizedFallback = normalizeToolKey(requested);
        return (
            !!requestedNormalizedFallback &&
            candidateNormalized === requestedNormalizedFallback
        );
    }

    private registerMetadataEntry(
        map: Map<string, MCPToolMetadata>,
        providersWithMetadata: Set<string>,
        providerId: string,
        toolName: string,
        metadata: MCPToolMetadata,
    ): void {
        const canonicalProvider = providerId?.trim();
        const canonicalTool = toolName?.trim();

        if (!canonicalProvider || !canonicalTool) {
            return;
        }

        map.set(`${canonicalProvider}|${canonicalTool}`, metadata);
        markProviderHasMetadata(providersWithMetadata, canonicalProvider);
    }
}
