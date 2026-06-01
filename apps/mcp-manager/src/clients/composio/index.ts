import { AuthScheme } from '@composio/core';

import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

const authSchemaMap = {
    OAUTH2: AuthScheme.OAuth2,
    OAUTH1: AuthScheme.OAuth1,
    API_KEY: AuthScheme.APIKey,
    BASIC: AuthScheme.Basic,
    BEARER_TOKEN: AuthScheme.BearerToken,
    GOOGLE_SERVICE_ACCOUNT: AuthScheme.GoogleServiceAccount,
    NO_AUTH: AuthScheme.NoAuth,
    BASIC_WITH_JWT: AuthScheme.BasicWithJWT,
    COMPOSIO_LINK: AuthScheme.ComposioLink,
    CALCOM_AUTH: AuthScheme.CalcomAuth,
};

export class ComposioClient {
    private readonly client: AxiosInstance;

    constructor(private configService: ConfigService) {
        this.client = axios.create({
            baseURL: this.configService.get('composio.baseUrl'),
            headers: {
                'x-api-key': this.configService.get('composio.apiKey'),
                'Content-Type': 'application/json',
            },
        });
    }

    private getMCPUrl(serverId: string, connectedAccountId: string): string {
        return `https://backend.composio.dev/v3/mcp/${serverId}?connected_account_id=${connectedAccountId}`;
    }

    async getIntegrations(params: {
        appName?: string;
        limit?: number;
        cursor?: string;
    }): Promise<any> {
        const query = {
            toolkit_slug: params.appName || undefined,
            limit: params.limit || undefined,
            cursor: params.cursor || undefined,
        };

        const { data } = await this.client.get<any>('/auth_configs', {
            params: query,
        });

        return data;
    }

    async getIntegration(integrationId: string): Promise<any> {
        const { data } = await this.client.get<any>(
            `/auth_configs/${integrationId}`,
        );

        return data;
    }

    async getTools(params: {
        appName?: string;
        tools?: string[];
        limit?: number;
        cursor?: string;
    }): Promise<any> {
        const query = {
            toolkit_slug: params.appName || undefined,
            limit: params.limit || 500,
            cursor: params.cursor || undefined,
            tool_slugs: params.tools?.join(',') || undefined,
        };

        const { data } = await this.client.get<any>(`/tools`, {
            params: query,
        });

        return data;
    }

    async getConnectedAccounts(params: {
        integrationIds?: string[];
        appNames?: string[];
        limit?: number;
        cursor?: string;
    }): Promise<any> {
        const query = {
            auth_config_ids: params.integrationIds?.join(',') || undefined,
            toolkit_slugs: params.appNames?.join(',') || undefined,
            limit: params.limit || undefined,
            cursor: params.cursor || undefined,
        };

        const { data } = await this.client.get('/connected_accounts', {
            params: query,
        });

        return data;
    }

    async getConnectedAccount(connectedAccountId: string): Promise<any> {
        const { data } = await this.client.get(
            `/connected_accounts/${connectedAccountId}`,
        );
        return data;
    }

    async deleteConnectedAccount(connectedAccountId: string): Promise<any> {
        const { data } = await this.client.delete(
            `/connected_accounts/${connectedAccountId}`,
        );
        return data;
    }

    async createConnectedAccount(params: {
        integrationId: string;
        userId: string;
        authScheme: string;
        callbackUrl: string;
        params: any;
    }) {
        const authSchemaVal = authSchemaMap[params.authScheme]({
            ...params.params,
        });

        const body = {
            auth_config: {
                id: params.integrationId,
            },
            connection: {
                user_id: params.userId,
                callback_url: params.callbackUrl,
                state: authSchemaVal,
            },
        };

        const { data } = await this.client.post('/connected_accounts', body);
        return data;
    }

    async createMCPServer(params: {
        appName: string;
        userId: string;
        integrationId: string;
        connectedAccountId: string;
        allowedTools?: string[];
    }): Promise<any> {
        const name = `${params.appName}-${params.userId.trim()}`
            .replace(/ /g, '-')
            .substring(0, 25);

        const { data } = await this.client.post<any>('/mcp/servers', {
            name,
            auth_config_ids: [params.integrationId],
            allowed_tools: params.allowedTools?.length
                ? params.allowedTools
                : undefined,
        });

        data.mcp_url = this.getMCPUrl(data.id, params.connectedAccountId);

        return data;
    }

    async getMCPServer(integrationId: string): Promise<any> {
        const { data } = await this.client.get('/mcp/servers', {
            params: { auth_config_ids: integrationId },
        });

        return data.items[0];
    }

    async getActiveMCPServers(): Promise<any> {
        const { data } = await this.client.get('/mcp/servers');
        return data?.items || [];
    }
}
