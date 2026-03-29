import { MCPServerConfig, createLogger } from '@kodus/flow';
import { TransportType } from '@kodus/flow/dist/core/types/allTypes';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AxiosMCPManagerService } from '@libs/core/infrastructure/config/axios/microservices/mcpManager.axios';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

type MCPConnection = {
    id: string;
    mcpUrl: string;
    status: string;
    appName: string;
    authUrl: string;
    allowedTools: string[];
};

type Metadata = {
    connection: MCPConnection;
};

type MCPItem = {
    id: string;
    organizationId: string;
    integrationId: string;
    provider: string;
    status: string;
    appName: string;
    mcpUrl: string;
    allowedTools: string[];
    metadata: Metadata;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
};

type MCPData = {
    items: MCPItem[];
};

enum MCPIntegrationAuthType {
    NONE = 'none',
    API_KEY = 'api_key',
    BASIC = 'basic',
    BEARER_TOKEN = 'bearer_token',
    OAUTH2 = 'oauth2',
}

enum MCPIntegrationProtocol {
    HTTP = 'http',
    SSE = 'sse',
}

interface MCPIntegrationEntity {
    id: string;
    active: boolean;
    organizationId: string;
    protocol: MCPIntegrationProtocol;
    baseUrl: string;
    name: string;
    description?: string;
    logoUrl?: string;
    authType: MCPIntegrationAuthType;
    auth?: string;
    headers?: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
}

type MCPIntegrationInterface =
    | MCPIntegrationNone
    | MCPIntegrationBearerToken
    | MCPIntegrationApiKey
    | MCPIntegrationBasic
    | MCPIntegrationOAuth2;

interface MCPIntegrationBase extends Omit<
    MCPIntegrationEntity,
    'authType' | 'auth' | 'headers'
> {
    headers?: Record<string, string>;
}

interface MCPIntegrationNone extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.NONE;
}

interface MCPIntegrationBearerToken extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.BEARER_TOKEN;
    bearerToken: string;
}

interface MCPIntegrationApiKey extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.API_KEY;
    apiKey: string;
    apiKeyHeader: string;
}

interface MCPIntegrationBasic extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.BASIC;
    basicUser: string;
    basicPassword?: string;
}

interface MCPIntegrationOAuth2 extends MCPIntegrationBase {
    authType: MCPIntegrationAuthType.OAUTH2;
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    accessToken?: string;
    refreshToken?: string;
    tokenExpiry?: number;
}

export const KODUS_MCP_INTEGRATION_ID = 'kd_mcp_oTUrzqsaxTg';
export const KODUS_MCP_GITHUB_ISSUES_INTEGRATION_ID =
    'kodus-github-issues-default';

@Injectable()
export class MCPManagerService {
    private readonly logger = createLogger(MCPManagerService.name);
    private axiosMCPManagerService: AxiosMCPManagerService;

    constructor(
        private readonly jwt: JwtService,
        private readonly permissionValidationService: PermissionValidationService,
    ) {
        this.axiosMCPManagerService = new AxiosMCPManagerService();
    }

    private generateToken(organizationId: string): string {
        return this.jwt.sign(
            {
                organizationId,
            },
            {
                secret: process.env.API_JWT_SECRET || '',
            },
        );
    }

    private getAuthHeaders(organizationAndTeamData: OrganizationAndTeamData): {
        Authorization: string;
    } {
        const token = this.generateToken(
            organizationAndTeamData.organizationId,
        );
        return {
            Authorization: `Bearer ${token}`,
        };
    }

    public async getConnections(
        organizationAndTeamData: OrganizationAndTeamData,
        format?: true,
    ): Promise<MCPServerConfig[]>;

    public async getConnections(
        organizationAndTeamData: OrganizationAndTeamData,
        format?: false,
    ): Promise<MCPItem[]>;

    public async getConnections(
        organizationAndTeamData: OrganizationAndTeamData,
        format: boolean = true,
        filters?: {
            provider?: string;
            status?: string;
        },
    ): Promise<MCPItem[] | MCPServerConfig[]> {
        try {
            const limited =
                await this.permissionValidationService.shouldLimitResources(
                    organizationAndTeamData,
                    MCPManagerService.name,
                );

            const { provider, status = 'ACTIVE' } = filters || {};

            const data: MCPData = await this.axiosMCPManagerService.get(
                'mcp/connections',
                {
                    headers: this.getAuthHeaders(organizationAndTeamData),
                    params: { provider, status },
                },
            );

            if (!data) {
                return [];
            }

            const limitedData = limited ? data.items.slice(0, 3) : data.items;

            if (format) {
                const results = await Promise.allSettled(
                    limitedData.map((connection) =>
                        this.formatConnection(connection),
                    ),
                );

                const formattedConnections = results
                    .filter(
                        (
                            result,
                        ): result is PromiseFulfilledResult<MCPServerConfig> =>
                            result.status === 'fulfilled',
                    )
                    .map((result) => result.value);

                results.forEach((result, index) => {
                    if (result.status === 'rejected') {
                        this.logger.error({
                            message: `Failed to format connection for app: ${limitedData[index]?.appName}`,
                            context: MCPManagerService.name,
                            error: result.reason,
                            metadata: {
                                organizationId:
                                    limitedData[index]?.organizationId,
                                connection: limitedData[index]?.appName,
                            },
                        });
                    }
                });

                return formattedConnections;
            }

            return limitedData;
        } catch (error) {
            this.logger.error({
                message: 'Error fetching MCP connections',
                context: MCPManagerService.name,
                error: error,
                metadata: { organizationAndTeamData },
            });
            return [];
        }
    }

    public async createKodusMCPIntegration(
        organizationId: string,
    ): Promise<void> {
        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
            };

            await this.axiosMCPManagerService.post(
                `mcp/integration/kodusmcp`,
                {
                    integrationId: KODUS_MCP_INTEGRATION_ID,
                    baseUrl: process.env.API_KODUS_MCP_SERVER_URL ?? '',
                },
                {
                    headers: this.getAuthHeaders(organizationAndTeamData),
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error creating Kodus MCP integration',
                context: MCPManagerService.name,
                error: error,
                metadata: { organizationId },
            });
            return null;
        }
    }

    public async deleteConnectionByIntegrationId(
        organizationAndTeamData: OrganizationAndTeamData,
        integrationId: string,
    ): Promise<boolean> {
        try {
            const data: MCPData = await this.axiosMCPManagerService.get(
                'mcp/connections',
                {
                    headers: this.getAuthHeaders(organizationAndTeamData),
                    params: { status: 'ACTIVE' },
                },
            );

            const connection = data?.items?.find(
                (item) => item.integrationId === integrationId,
            );

            if (!connection) {
                return false;
            }

            await this.axiosMCPManagerService.delete(
                `mcp/connections/${connection.id}`,
                {},
                {
                    headers: this.getAuthHeaders(organizationAndTeamData),
                },
            );

            return true;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to delete MCP connection by integration ID',
                context: MCPManagerService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    integrationId,
                },
            });
            return false;
        }
    }

    private async formatConnection(
        connection: MCPItem,
    ): Promise<MCPServerConfig> {
        let headers: Record<string, string> = {};
        let type: string = 'http';
        if (connection.provider === 'custom') {
            const integration =
                await this.fetchCustomIntegrationConfig(connection);

            if (!integration) {
                throw new Error(
                    `Integration not found: ${connection.integrationId}`,
                );
            }

            headers = { ...integration.headers };

            switch (integration.authType) {
                case MCPIntegrationAuthType.BEARER_TOKEN:
                    headers['Authorization'] =
                        `Bearer ${(integration as MCPIntegrationBearerToken).bearerToken}`;
                    break;
                case MCPIntegrationAuthType.API_KEY: {
                    const apiKeyIntegration =
                        integration as MCPIntegrationApiKey;
                    headers[apiKeyIntegration.apiKeyHeader] =
                        apiKeyIntegration.apiKey;
                    break;
                }
                case MCPIntegrationAuthType.BASIC: {
                    const basicIntegration = integration as MCPIntegrationBasic;
                    const credentials = Buffer.from(
                        `${basicIntegration.basicUser}:${basicIntegration.basicPassword ?? ''}`,
                    ).toString('base64');
                    headers['Authorization'] = `Basic ${credentials}`;
                    break;
                }
                case MCPIntegrationAuthType.OAUTH2: {
                    const oauth2Integration =
                        integration as MCPIntegrationOAuth2;
                    if (oauth2Integration.accessToken) {
                        headers['Authorization'] =
                            `Bearer ${oauth2Integration.accessToken}`;
                    }
                    break;
                }
                case MCPIntegrationAuthType.NONE:
                default:
                    break;
            }

            type = integration.protocol;
        }

        return {
            name: connection.appName,
            provider: connection.provider,
            type: type as TransportType,
            url: connection.mcpUrl,
            headers,
            retries: 1,
            timeout: 60_000,
            allowedTools: connection.allowedTools,
        };
    }

    private async fetchCustomIntegrationConfig(
        connection: MCPItem,
    ): Promise<MCPIntegrationInterface | undefined> {
        const headers = {
            headers: this.getAuthHeaders({
                organizationId: connection.organizationId,
            }),
        };

        return (await this.axiosMCPManagerService.get(
            `mcp/integration/custom/${connection.integrationId}/connection-config`,
            headers,
        )) as MCPIntegrationInterface | undefined;
    }
}
