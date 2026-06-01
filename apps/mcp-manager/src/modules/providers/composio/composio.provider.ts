import {
    MCPConnection,
    MCPConnectionConfig,
    MCPIntegration,
    MCPProviderConfig,
    MCPServer,
    MCPServerConfig,
    MCPRequiredParam,
    MCPInstallIntegration,
    MCPTool,
    MCPProviderType,
} from '../interfaces/provider.interface';
import { Injectable } from '@nestjs/common';
import { BaseProvider } from '../base.provider';
import { ConfigService } from '@nestjs/config';
import { MCPConnectionStatus } from '../../mcp/entities/mcp-connection.entity';
import { BadRequestException } from '@nestjs/common';
import { ComposioClient } from '../../../clients/composio';
import { IntegrationDescriptionService } from '../services/integration-description.service';
interface ActiveMCPServer {
    id: string;
    name: string;
    auth_config_ids: string[];
    managed_auth_via_composio: boolean;
    allowed_tools: string[];
    mcp_url: string;
    toolkits: string[];
    toolkit_icons: Record<string, string>;
    commands: {
        cursor: string;
        claude: string;
        windsurf: string;
    };
    updated_at: string;
    created_at: string;
    server_instance_count: number;
}

@Injectable()
export class ComposioProvider extends BaseProvider {
    private readonly client: ComposioClient;
    private readonly config: MCPProviderConfig;
    private readonly integrationDescriptionService: IntegrationDescriptionService;

    public readonly statusMap = {
        INITIALIZING: MCPConnectionStatus.PENDING,
        INITIATED: MCPConnectionStatus.PENDING,
        ACTIVE: MCPConnectionStatus.ACTIVE,
        FAILED: MCPConnectionStatus.FAILED,
        EXPIRED: MCPConnectionStatus.EXPIRED,
        INACTIVE: MCPConnectionStatus.INACTIVE,

        // oauth2 statuses
        success: MCPConnectionStatus.ACTIVE,
        error: MCPConnectionStatus.FAILED,
    };

    constructor(
        configService: ConfigService,
        integrationDescriptionService: IntegrationDescriptionService,
    ) {
        super();
        this.config = {
            apiKey: configService.get(`composio.apiKey`),
            baseUrl: configService.get(`composio.baseUrl`),
            redirectUri: configService.get('redirectUri'),
        };
        this.client = new ComposioClient(configService);
        this.integrationDescriptionService = integrationDescriptionService;
    }

    private getMCPUrl(serverId: string, authConfigId: string): string {
        return `https://backend.composio.dev/v3/mcp/${serverId}?connected_account_id=${authConfigId}`;
    }

    private validateRequiredParams(
        requiredParams: MCPRequiredParam[],
        params: MCPInstallIntegration,
    ): void {
        if (requiredParams.length === 0) return;

        if (!params) {
            throw new BadRequestException(
                `Missing required params: ${requiredParams.map((param) => param.name).join(', ')}`,
            );
        }

        const missingParams = [];
        requiredParams.forEach((param) => {
            if (params[param.name] === undefined && param.required) {
                missingParams.push(param.name);
            }
        });

        if (missingParams.length > 0) {
            throw new BadRequestException(
                `Missing required params: ${missingParams.join(', ')}`,
            );
        }
    }

    async getIntegrations(
        cursor: string = '',
        limit = 50,
        filters?: Record<string, any>,
    ): Promise<MCPIntegration[]> {
        const result = await this.client.getIntegrations({});

        return result.items.map((integration) => ({
            id: integration.id,
            name: integration.name,
            description: this.integrationDescriptionService.getDescription(
                'composio',
                integration.toolkit.slug,
            ),
            authScheme: integration.auth_scheme,
            appName: integration.toolkit.slug,
            logo: integration.toolkit.logo,
            provider: 'composio',
        }));
    }

    async getIntegration(integrationId: string): Promise<MCPIntegration> {
        this.validateId(integrationId, 'Integration');
        const integration = await this.client.getIntegration(integrationId);
        return {
            id: integration.id,
            name: integration.name,
            description: this.integrationDescriptionService.getDescription(
                'composio',
                integration.toolkit.slug,
            ),
            authScheme: integration.auth_scheme,
            appName: integration.toolkit.slug,
            logo: integration.toolkit.logo,
            provider: MCPProviderType.COMPOSIO,
            allowedTools: integration.restrict_to_following_tools,
        };
    }

    async getIntegrationRequiredParams(
        integrationId: string,
    ): Promise<MCPRequiredParam[]> {
        this.validateId(integrationId, 'Integration');
        const integration = await this.client.getIntegration(integrationId);
        return (
            integration.expected_input_fields?.map((param: any) => ({
                name: param.name,
                displayName: param.displayName,
                description: param.description,
                type: param.type,
                required: param.required,
            })) || []
        );
    }

    async getIntegrationTools(integrationId: string): Promise<MCPTool[]> {
        this.validateId(integrationId, 'Integration');
        const integration = await this.client.getIntegration(integrationId);

        const activeMCPServers: ActiveMCPServer[] =
            await this.client.getActiveMCPServers();

        const activeMCPServer: ActiveMCPServer = activeMCPServers.find(
            (server) => server.auth_config_ids.includes(integrationId),
        );

        const { items } = await this.client.getTools({
            appName: integration.toolkit.slug,
            tools: integration.restrict_to_following_tools,
        });

        const allowedToolsSet = activeMCPServer?.allowed_tools
            ? new Set(activeMCPServer.allowed_tools)
            : null;

        return items
            .filter((tool) => {
                if (!activeMCPServer) {
                    return true;
                }
                if (!allowedToolsSet) {
                    return false;
                }
                return allowedToolsSet.has(tool.slug);
            })
            .map((tool) => ({
                slug: tool.slug,
                name: tool.name,
                description: tool.description,
                provider: 'composio',
                warning: this.hasWarning(tool.name || tool.slug),
            }));
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

    async initiateConnection(
        config: MCPConnectionConfig,
    ): Promise<MCPConnection> {
        //this.validateConfig(config);

        const requiredParams = await this.getIntegrationRequiredParams(
            config.integrationId,
        );

        if (requiredParams.length > 0)
            this.validateRequiredParams(requiredParams, config.params);

        const { integrationId, organizationId } = config;

        const redirectUrl = this.buildRedirectUri(this.config.redirectUri, {
            provider: 'composio',
            integrationId,
        });

        const integration = await this.getIntegration(integrationId);

        // TODO: UPSERT CONNECTED ACCOUNT

        const connectionRequest = await this.client.createConnectedAccount({
            integrationId: integration.id,
            userId: organizationId,
            authScheme: integration.authScheme,
            callbackUrl: redirectUrl,
            params: config.params,
        });

        const mcp = await this.client.getMCPServer(integrationId);

        let allowedTools = config.allowedTools;

        if (!allowedTools?.length) allowedTools = integration.allowedTools;

        if (!allowedTools?.length)
            allowedTools = (await this.getIntegrationTools(integrationId)).map(
                (tool) => tool.slug,
            );

        return {
            id: connectionRequest.id,
            appName: integration.appName,
            authUrl: connectionRequest.redirect_url || '',
            status: this.statusMap[connectionRequest.status],
            mcpUrl: this.getMCPUrl(mcp.id, connectionRequest.id),
            allowedTools: allowedTools,
        };
    }

    async getConnections(
        cursor = '',
        limit = 10,
        filters?: Record<string, any>,
    ): Promise<{ data: MCPConnection[]; total: number }> {
        const result: any = await this.client.getConnectedAccounts({
            limit,
            cursor,
            integrationIds: filters?.integrationId,
            appNames: filters?.appName,
        });

        return {
            data: result.data.map((connection) => ({
                id: connection.id,
                status: connection.status,
            })),
            total: result.total,
        };
    }

    async getConnection(connectedAccountId: string): Promise<any> {
        return this.client.getConnectedAccount(connectedAccountId);
    }

    async deleteConnection(connectionId: string): Promise<void> {
        this.validateId(connectionId, 'Connection');
        await this.client.deleteConnectedAccount(connectionId);
    }

    async createMCPServer(config: MCPServerConfig): Promise<MCPServer> {
        // this.validateConfig(config);
        const {
            organizationId,
            appName,
            authConfigId,
            allowedTools,
            integrationId,
        } = config;

        const data: any = await this.client.createMCPServer({
            appName,
            userId: organizationId,
            integrationId,
            connectedAccountId: authConfigId,
            allowedTools,
        });

        return {
            id: data.id,
            name: data.name,
            authConfigIds: data.auth_config_ids,
            mcpUrl: this.getMCPUrl(data.id, authConfigId),
        } as any;
    }

    async getMCPServer(integrationId: string): Promise<{ items: MCPServer[] }> {
        this.validateId(integrationId, 'Integration');

        const data = await this.client.getMCPServer(integrationId);

        return { items: [data] } as any;
    }
}
