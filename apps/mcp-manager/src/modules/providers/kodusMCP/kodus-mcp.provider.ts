import { Injectable, Logger } from '@nestjs/common';

import managedMcpServers from '../../../config/managed-mcp-servers.json';
import { CustomClient } from '../../../clients/custom';
import { KodusMCPClient } from '../../../clients/kodusMCP';
import {
    MCPIntegrationAuthType,
    MCPIntegrationOAuthStatus,
    MCPIntegrationProtocol,
} from '../../integrations/enums/integration.enum';
import { IntegrationOAuthService } from '../../integrations/integration-oauth.service';
import { MCPIntegrationAllUniqueFields } from '../../integrations/interfaces/mcp-integration.interface';
import { MCPConnectionStatus } from '../../mcp/entities/mcp-connection.entity';
import { BaseProvider } from '../base.provider';
import {
    MCPConnection,
    MCPConnectionConfig,
    MCPIntegration,
    MCPProviderType,
    MCPRequiredParam,
    MCPTool,
} from '../interfaces/provider.interface';
import { IntegrationDescriptionService } from '../services/integration-description.service';

interface ManagedIntegrationConfig {
    id: string;
    name: string;
    baseUrl: string;
    protocol: MCPIntegrationProtocol;
    logoUrl: string;
    headers: Record<string, string>;
    auth: {
        type: MCPIntegrationAuthType;
    } & MCPIntegrationAllUniqueFields;
}

@Injectable()
export class KodusMCPProvider extends BaseProvider {
    private readonly client: KodusMCPClient;
    private readonly integrationDescriptionService: IntegrationDescriptionService;
    private readonly managedIntegrations: Map<
        string,
        { config: ManagedIntegrationConfig }
    > = new Map();
    statusMap: Record<string, MCPConnectionStatus> = {
        ACTIVE: MCPConnectionStatus.ACTIVE,
        INACTIVE: MCPConnectionStatus.INACTIVE,
        FAILED: MCPConnectionStatus.FAILED,
    };
    private readonly logger: Logger = new Logger(KodusMCPProvider.name);
    constructor(
        integrationDescriptionService: IntegrationDescriptionService,
        private readonly integrationOAuthService: IntegrationOAuthService,
    ) {
        super();

        this.client = new KodusMCPClient();
        this.integrationDescriptionService = integrationDescriptionService;

        this.loadManagedIntegrationsFromConfig();
    }

    private loadManagedIntegrationsFromConfig() {
        try {
            // Imported at build time via `resolveJsonModule`. Webpack (the
            // active builder per nest-cli.json `builder: webpack`, used in
            // both dev and prod) inlines the JSON into the compiled bundle,
            // so there is no runtime fs lookup. Path-resolve / dist-fallback
            // are not needed.
            const managedConfigs =
                managedMcpServers as ManagedIntegrationConfig[];

            for (const entry of managedConfigs) {
                entry.baseUrl = this.resolveManagedBaseUrl(entry.baseUrl);
                this.managedIntegrations.set(entry.id, {
                    config: entry,
                });
            }
        } catch (error) {
            this.logger.error(
                'Failed to load managed HTTP integrations from config:',
                { error },
            );
        }
    }

    private resolveManagedBaseUrl(baseUrl: string): string {
        if (!baseUrl.startsWith('/')) {
            return baseUrl;
        }

        // Relative base URLs (e.g. `/mcp/github-issues`) are absolute paths
        // served by the kodus-api MCP server, NOT the mcp-manager. Resolve
        // against the kodus-api origin so the URL ends up addressable.
        //
        // `API_KODUS_MCP_SERVER_URL` (already in every .env) carries the
        // canonical address — e.g. `http://kodus_api:3001/mcp`. We extract
        // just the origin (protocol://host:port) and append the JSON's
        // absolute path; this avoids double-prefixing `/mcp/...`.
        //
        // `API_MCP_MANAGER_BACKEND_URL` remains as an explicit override for
        // deployments where the MCP server is published at a different
        // origin (e.g. cloud edge URL).
        const override = process.env.API_MCP_MANAGER_BACKEND_URL;
        if (override) {
            return `${override.replace(/\/$/, '')}${baseUrl}`;
        }

        const mcpServerUrl = process.env.API_KODUS_MCP_SERVER_URL;
        if (!mcpServerUrl) {
            throw new Error(
                'Cannot resolve relative MCP base URL: set API_KODUS_MCP_SERVER_URL or API_KODUS_MCP_MANAGER_BACKEND_URL',
            );
        }

        const origin = new URL(mcpServerUrl).origin;
        return `${origin}${baseUrl}`;
    }

    private transformManagedIntegration(
        managed: ManagedIntegrationConfig,
    ): ConstructorParameters<typeof CustomClient>[0] {
        return {
            id: managed.id,
            name: managed.name,
            authType: managed.auth.type,
            protocol: managed.protocol,
            baseUrl: managed.baseUrl,
            logoUrl: managed.logoUrl,
            headers: managed.headers,
            serverName: managed.name,
            providerType: MCPProviderType.KODUSMCP,
            ...managed.auth,
        } as unknown as ConstructorParameters<typeof CustomClient>[0];
    }

    async getIntegrations(
        cursor: string = '',
        limit = 50,
        filters?: Record<string, any>,
    ): Promise<MCPIntegration[]> {
        const { organizationId } = filters;

        try {
            if (!organizationId) {
                throw new Error('Missing organizationId');
            }

            const integration = await this.client.getIntegration();
            const managedIntegrations = await Promise.all(
                Array.from(this.managedIntegrations.keys()).map(
                    (integrationId) =>
                        this.buildManagedHttpIntegration(
                            organizationId,
                            integrationId,
                        ),
                ),
            );

            return [
                {
                    ...integration,
                    provider: MCPProviderType.KODUSMCP,
                    isDefault: true,
                },
                ...managedIntegrations,
            ];
        } catch (error) {
            this.logger.error('Failed to get integrations:', {
                organizationId,
                error,
            });
            throw error;
        }
    }

    async getIntegration(
        integrationId: string,
        organizationId: string,
    ): Promise<MCPIntegration> {
        try {
            if (this.managedIntegrations.has(integrationId)) {
                return this.buildManagedHttpIntegration(
                    organizationId,
                    integrationId,
                );
            }

            const integration = await this.client.getIntegration();

            if (integration.id !== integrationId) {
                throw new Error(
                    `Integration ${integrationId} não suportada pela Kodus`,
                );
            }

            return {
                id: integration.id,
                name: integration.name,
                description: this.integrationDescriptionService.getDescription(
                    'composio',
                    integration.appName,
                ),
                authScheme: integration.authScheme,
                appName: integration.appName,
                logo: integration.logo,
                provider: MCPProviderType.KODUSMCP,
                isDefault: true,
                allowedTools: integration.allowedTools,
            };
        } catch (error) {
            this.logger.error('Failed to get integration:', {
                integrationId,
                organizationId,
                error,
            });
            throw error;
        }
    }

    getIntegrationRequiredParams(
        integrationId: string,
    ): Promise<MCPRequiredParam[]> {
        return null;
    }

    async getIntegrationTools(
        integrationId: string,
        organizationId: string,
    ): Promise<MCPTool[]> {
        try {
            this.validateId(integrationId, 'Integration');

            const managed = this.managedIntegrations.get(integrationId);
            if (managed) {
                const client = await this.buildManagedClient(
                    organizationId,
                    integrationId,
                );

                return this.safeGetTools(client);
            }

            const tools = await this.client.getTools();

            return tools.map((tool) => ({
                slug: tool.slug,
                name: tool.name,
                description: tool.description,
                provider: MCPProviderType.KODUSMCP,
                warning: this.hasWarning(tool.name || tool.slug),
            }));
        } catch (error) {
            this.logger.error('Failed to get integration tools:', {
                integrationId,
                organizationId,
                error,
            });
            throw error;
        }
    }

    async updateSelectedTools(
        integrationId: string,
        organizationId: string,
        selectedTools: string[],
    ): Promise<{ success: boolean; message: string; selectedTools: string[] }> {
        try {
            if (this.managedIntegrations.has(integrationId)) {
                return {
                    success: true,
                    message:
                        'Selected tools updated for managed Kodus MCP integration.',
                    selectedTools,
                };
            }
            return Promise.resolve(
                this.client.updateSelectedTools(organizationId, selectedTools),
            );
        } catch (error) {
            this.logger.error('Failed to update selected tools:', {
                integrationId,
                organizationId,
                error,
            });
            throw error;
        }
    }

    async initiateConnection(
        config: MCPConnectionConfig,
    ): Promise<MCPConnection> {
        try {
            const managed = this.managedIntegrations.get(config.integrationId);
            if (managed) {
                const client = await this.buildManagedClient(
                    config.organizationId,
                    config.integrationId,
                );
                const tools = await this.safeGetTools(client);
                const allToolSlugs = tools.map((tool) => tool.slug);

                const allowedTools =
                    config.allowedTools && config.allowedTools.length > 0
                        ? config.allowedTools
                        : allToolSlugs;

                return {
                    id: managed.config.id,
                    appName: managed.config.name,
                    authUrl: null,
                    mcpUrl: managed.config.baseUrl,
                    status: MCPConnectionStatus.ACTIVE,
                    allowedTools,
                };
            }

            throw new Error(
                `Integration ${config.integrationId} não suportada para conexão Kodus`,
            );
        } catch (error) {
            this.logger.error('Failed to initiate connection:', {
                config,
                error,
            });
            throw error;
        }
    }

    deleteConnection(connectionId: string): Promise<void> {
        return Promise.resolve();
    }

    getConnections(
        cursor?: string,
        limit?: number,
        filters?: Record<string, any>,
    ): Promise<{ data: MCPConnection[]; total: number }> {
        throw new Error('Method not implemented.');
    }

    private hasWarning(toolName: string): boolean {
        const warningKeywords = [
            'delete',
            'remove',
            'archive',
            'destroy',
            'drop',
            'clear',
            'erase',
            'purge',
            'terminate',
            'kill',
            'stop',
            'disable',
            'suspend',
            'revoke',
            'cancel',
            'reject',
            'deny',
            'block',
            'ban',
            'uninstall',
            'reset',
            'revert',
            'undo',
            'rollback',
            'flush',
            'wipe',
            'truncate',
        ];
        const lowerToolName = toolName.toLowerCase();
        return warningKeywords.some((keyword) =>
            lowerToolName.includes(keyword),
        );
    }

    private async buildManagedHttpIntegration(
        organizationId: string,
        integrationId: string,
    ): Promise<MCPIntegration> {
        const entry = this.managedIntegrations.get(integrationId);

        if (!entry) {
            throw new Error(
                `Integration ${integrationId} não suportada pela Kodus`,
            );
        }

        let active = true;

        if (entry.config.auth.type === MCPIntegrationAuthType.OAUTH2) {
            const status = await this.integrationOAuthService.getOAuthStatus(
                organizationId,
                integrationId,
            );

            active = status === MCPIntegrationOAuthStatus.ACTIVE;
        }

        let tools: MCPTool[] = [];
        if (active) {
            const client = await this.buildManagedClient(
                organizationId,
                integrationId,
            );
            tools = await this.safeGetTools(client);
        }

        return {
            id: entry.config.id,
            active,
            name: entry.config.name,
            description: this.integrationDescriptionService.getDescription(
                'kodusmcp',
                entry.config.id,
            ),
            authScheme: entry.config.auth.type,
            appName: entry.config.name,
            logo: entry.config.logoUrl,
            provider: MCPProviderType.KODUSMCP,
            allowedTools: tools.map((tool) => tool.slug),
            baseUrl: entry.config.baseUrl,
            protocol: entry.config.protocol ?? 'http',
            isDefault: false,
        };
    }

    private async buildManagedClient(
        organizationId: string,
        integrationId: string,
    ): Promise<CustomClient> {
        const entry = this.managedIntegrations.get(integrationId);

        if (!entry) {
            throw new Error(
                `Integration ${integrationId} não suportada pela Kodus`,
            );
        }

        const baseIntegration = this.transformManagedIntegration(
            entry.config,
        ) as any;

        if (entry.config.auth.type === MCPIntegrationAuthType.OAUTH2) {
            let oauthState = await this.integrationOAuthService.getOAuthState(
                organizationId,
                integrationId,
            );

            if (oauthState) {
                try {
                    oauthState =
                        await this.integrationOAuthService.refreshOAuthStateIfNeeded(
                            {
                                organizationId,
                                integrationId,
                                oauthState,
                            },
                        );
                } catch (error) {
                    console.error(
                        'Failed to refresh managed Kodus MCP OAuth tokens:',
                        error,
                    );
                }
            }

            return new CustomClient({
                ...baseIntegration,
                tokens: oauthState?.tokens,
            });
        }

        return new CustomClient(baseIntegration);
    }

    async initiateManagedOAuth(
        organizationId: string,
        integrationId: string,
    ): Promise<string> {
        try {
            const entry = this.managedIntegrations.get(integrationId);

            if (!entry) {
                throw new Error(
                    `Integration ${integrationId} não suportada pela Kodus`,
                );
            }

            if (entry.config.auth.type !== MCPIntegrationAuthType.OAUTH2) {
                throw new Error('Integration is not OAuth2');
            }

            const { baseUrl } = entry.config;
            const { oauthScopes, dynamicRegistration, clientId, clientSecret } =
                entry.config.auth as any;

            const oauthInit = await this.integrationOAuthService.initiateOAuth({
                baseUrl,
                oauthScopes,
                dynamicRegistration,
                clientId,
                clientSecret,
            });

            await this.integrationOAuthService.saveOAuthState(
                organizationId,
                integrationId,
                MCPIntegrationOAuthStatus.PENDING,
                {
                    clientId: oauthInit.clientId,
                    clientSecret: oauthInit.clientSecret,
                    oauthScopes,
                    dynamicRegistration,
                    asMetadata: oauthInit.as,
                    rsMetadata: oauthInit.rs,
                    redirectUri: oauthInit.redirectUri,
                    codeChallenge: oauthInit.codeChallenge,
                    codeVerifier: oauthInit.codeVerifier,
                    state: oauthInit.state,
                    tokens: undefined,
                },
            );

            return oauthInit.authUrl;
        } catch (error) {
            this.logger.error('Failed to initiate managed OAuth:', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    async finalizeManagedOAuth(params: {
        organizationId: string;
        integrationId: string;
        code: string;
        state: string;
    }): Promise<void> {
        const { organizationId, integrationId, code, state } = params;
        try {
            const entry = this.managedIntegrations.get(integrationId);

            if (!entry) {
                throw new Error(
                    `Integration ${integrationId} não suportada pela Kodus`,
                );
            }

            if (entry.config.auth.type !== MCPIntegrationAuthType.OAUTH2) {
                throw new Error('Integration is not OAuth2');
            }

            const { baseUrl } = entry.config;

            const oauthState = await this.integrationOAuthService.getOAuthState(
                organizationId,
                integrationId,
            );

            if (!oauthState) {
                throw new Error('OAuth metadata missing for connection');
            }

            const { clientId, clientSecret } = oauthState;
            const {
                redirectUri,
                codeVerifier,
                state: storedState,
                asMetadata,
            } = oauthState;

            if (!asMetadata) {
                throw new Error('OAuth metadata missing for connection');
            }

            const { token_endpoint: tokenEndpoint } = asMetadata;

            if (
                !clientId ||
                !tokenEndpoint ||
                !redirectUri ||
                !codeVerifier ||
                !storedState
            ) {
                throw new Error('OAuth metadata missing for connection');
            }

            if (state !== storedState) {
                throw new Error('Invalid state parameter');
            }

            const tokens =
                await this.integrationOAuthService.exchangeAuthorizationCode({
                    baseUrl,
                    tokenEndpoint,
                    clientId,
                    clientSecret,
                    code,
                    codeVerifier,
                    redirectUri,
                    state,
                });

            await this.integrationOAuthService.saveOAuthState(
                organizationId,
                integrationId,
                MCPIntegrationOAuthStatus.ACTIVE,
                {
                    ...oauthState,
                    tokens,
                },
            );
        } catch (error) {
            this.logger.error('Failed to finalize managed OAuth:', {
                organizationId,
                integrationId,
                error,
            });
            throw error;
        }
    }

    private async safeGetTools(client: CustomClient): Promise<MCPTool[]> {
        try {
            return await client.getTools();
        } catch (error) {
            console.error('Failed to fetch managed Kodus MCP tools:', error);
            return [];
        }
    }
}
