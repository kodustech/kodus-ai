import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CustomClient } from '../../../clients/custom';
import {
    MCPIntegrationAuthType,
    MCPIntegrationOAuthStatus,
} from '../../integrations/enums/integration.enum';
import { IntegrationOAuthService } from '../../integrations/integration-oauth.service';
import { IntegrationsService } from '../../integrations/integrations.service';
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

@Injectable()
export class CustomProvider extends BaseProvider {
    statusMap: Record<string, MCPConnectionStatus> = {
        ACTIVE: MCPConnectionStatus.ACTIVE,
        INACTIVE: MCPConnectionStatus.INACTIVE,
        FAILED: MCPConnectionStatus.FAILED,
    };

    constructor(
        private readonly configService: ConfigService,
        private readonly integrationDescriptionService: IntegrationDescriptionService,
        private readonly integrationsService: IntegrationsService,
        private readonly integrationOAuthService: IntegrationOAuthService,
    ) {
        super();
    }

    async getIntegrations(
        cursor?: string,
        limit?: number,
        filters?: Record<string, any>,
    ): Promise<MCPIntegration[]> {
        try {
            const organizationId = filters?.organizationId;

            if (!organizationId) {
                throw new BadRequestException(
                    'organizationId is required for custom integrations',
                );
            }

            const customIntegrations = await this.integrationsService.find({
                organizationId,
            });

            return customIntegrations.map((integration) => ({
                id: integration.id,
                name: integration.name,
                description: integration.description,
                authScheme: integration.authType,
                appName: integration.name,
                provider: MCPProviderType.CUSTOM,
                logo: integration.logoUrl,
                baseUrl: integration.baseUrl,
                protocol: integration.protocol,
                authType: integration.authType,
                headers: integration.headers,
                apiKeyHeader:
                    'apiKeyHeader' in integration
                        ? integration.apiKeyHeader
                        : undefined,
                basicUser:
                    'basicUser' in integration
                        ? integration.basicUser
                        : undefined,
                active: integration.active,
            }));
        } catch (error) {
            console.error('Error fetching custom integrations:', error);
            return [];
        }
    }

    async getIntegration(
        integrationId: string,
        organizationId: string,
    ): Promise<MCPIntegration> {
        try {
            const integration =
                await this.integrationsService.getIntegrationById(
                    integrationId,
                    organizationId,
                );

            if (!integration) {
                return null;
            }

            let active = integration.active;

            if (integration.authType === MCPIntegrationAuthType.OAUTH2) {
                const oauthStatus =
                    await this.integrationOAuthService.getOAuthStatus(
                        organizationId,
                        integrationId,
                    );

                active = oauthStatus === MCPIntegrationOAuthStatus.ACTIVE;
            }

            return {
                id: integration.id,
                name: integration.name,
                description: integration.description,
                authScheme: integration.authType,
                appName: integration.name,
                provider: MCPProviderType.CUSTOM,
                logo: integration.logoUrl,
                baseUrl: integration.baseUrl,
                protocol: integration.protocol,
                authType: integration.authType,
                headers: integration.headers,
                apiKeyHeader:
                    'apiKeyHeader' in integration
                        ? integration.apiKeyHeader
                        : undefined,
                basicUser:
                    'basicUser' in integration
                        ? integration.basicUser
                        : undefined,
                active,
            };
        } catch (error) {
            console.error(
                `Error fetching custom integration ${integrationId}:`,
                error,
            );
            return null;
        }
    }

    getIntegrationRequiredParams(
        integrationId: string,
    ): Promise<MCPRequiredParam[]> {
        return Promise.resolve([]);
    }

    private async resolveIntegration(
        integrationId: string,
        organizationId: string,
    ) {
        const integration = await this.integrationsService.getIntegrationById(
            integrationId,
            organizationId,
        );

        if (!integration) {
            throw new NotFoundException('Custom integration not found');
        }

        if (integration.authType === MCPIntegrationAuthType.OAUTH2) {
            const oauthState = await this.integrationOAuthService.getOAuthState(
                organizationId,
                integrationId,
            );

            if (oauthState?.tokens) {
                integration.tokens = oauthState.tokens;
            }
        }

        return integration;
    }

    async getIntegrationTools(
        integrationId: string,
        organizationId: string,
    ): Promise<MCPTool[]> {
        try {
            const integration = await this.resolveIntegration(
                integrationId,
                organizationId,
            );

            const client = new CustomClient(integration);
            return await client.getTools();
        } catch (error) {
            console.error(
                `Error fetching tools for custom integration ${integrationId}:`,
                error,
            );
            return [];
        }
    }

    async initiateConnection(
        config: MCPConnectionConfig,
    ): Promise<MCPConnection> {
        try {
            const integration = await this.resolveIntegration(
                config.integrationId,
                config.organizationId,
            );

            let allowedTools = config.allowedTools;

            if (!allowedTools || allowedTools.length === 0) {
                const client = new CustomClient(integration);
                const tools = await client.getTools();
                allowedTools = tools.map((tool) => tool.slug);
            }

            return {
                id: integration.id,
                appName: integration.name,
                authUrl: null,
                mcpUrl: integration.baseUrl,
                status: MCPConnectionStatus.ACTIVE,
                allowedTools,
            };
        } catch (error) {
            console.error(
                `Error initiating connection for custom integration ${config.integrationId}:`,
                error,
            );
            return null;
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
        throw new Error('Method not implemented for custom provider.');
    }
}
