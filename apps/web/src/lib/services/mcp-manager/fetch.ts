import {
    CustomMCPAuthMethodType,
    CustomMCPPlugin,
    CustomMCPProtocolType,
    MCP_CONNECTION_STATUS,
    MCPAuthMethod,
    PluginAuthScheme,
} from "./types";
import { mcpManagerFetch } from "./utils";

export const getMCPPlugins = () =>
    mcpManagerFetch<
        Array<{
            id: string;
            name: string;
            description: string;
            authScheme: PluginAuthScheme;
            appName: string;
            logo: string;
            provider: string;
            isConnected: boolean;
            connectionStatus?: MCP_CONNECTION_STATUS;
            isDefault?: boolean;
            baseUrl?: string;
            active?: boolean;
        }>
    >("/mcp/integrations", { params: { page: 1, pageSize: 100 } });

export const getMCPPluginById = ({
    id,
    provider,
}: {
    id: string;
    provider: string;
}) =>
    mcpManagerFetch<{
        id: string;
        name: string;
        description: string;
        authScheme: PluginAuthScheme;
        appName: string;
        logo: string;
        provider: string;
        allowedTools: Array<string>;
        isConnected: boolean;
        isDefault?: boolean;
        connectionId?: string;
        mcpConnectionId?: string;
        requiredParams: Array<{
            name: string;
            displayName: string;
            description: string;
            type: "string";
            required: boolean;
        }>;
        baseUrl?: string;
        protocol?: string;
        authType?: string;
        headers?: Record<string, string>;
        apiKeyHeader?: string;
        basicUser?: string;
        clientId?: string;
        oauthScopes?: string[];
        dynamicRegistration?: boolean;
        active?: boolean;
        authMethods?: MCPAuthMethod[];
    }>(`/mcp/${provider}/integrations/${id}`);

export const getMCPPluginTools = ({
    id,
    provider,
}: {
    id: string;
    provider: string;
}) =>
    mcpManagerFetch<
        Array<{
            slug: string;
            name: string;
            description: string;
            provider: string;
            warning: boolean;
        }>
    >(`/mcp/${provider}/integrations/${id}/tools`);

export const installMCPPlugin = async ({
    id,
    provider,
    allowedTools,
    authParams = {},
}: {
    id: string;
    provider: string;
    allowedTools: string[];
    authParams: Record<string, any>;
}) => {
    const response = await mcpManagerFetch<{
        id: string;
        integrationId: string;
        organizationId: string;
        status: MCP_CONNECTION_STATUS;
        provider: string;
        mcpUrl: string;
        appName: string;
        allowedTools: Array<string>;
        metadata: {
            connection: {
                id: string;
                appName: string;
                authUrl: string;
                status: MCP_CONNECTION_STATUS;
                mcpUrl: string;
                allowedTools: Array<string>;
            };
        };
    }>(`/mcp/${provider}/connect`, {
        method: "POST",
        body: JSON.stringify({
            integrationId: id,
            allowedTools,
            authParams,
        }),
    });

    return response;
};

export const finishOauthMCPPluginInstallation = async ({
    id,
}: {
    id: string;
}) => {
    const response = await mcpManagerFetch<{}>(`/mcp/connections`, {
        method: "PATCH",
        body: JSON.stringify({
            integrationId: id,
            status: MCP_CONNECTION_STATUS.ACTIVE,
        }),
    });

    return response;
};

export const deleteMCPConnection = async ({
    connectionId,
}: {
    connectionId: string;
}) => {
    const response = await mcpManagerFetch<{}>(
        `/mcp/connections/${connectionId}`,
        {
            method: "DELETE",
            body: JSON.stringify({}),
        },
    );

    return response;
};

export const getMCPConnections = () =>
    mcpManagerFetch<{
        items: Array<{
            id: string;
            integrationId: string;
            organizationId: string;
            status: MCP_CONNECTION_STATUS;
            provider: string;
            mcpUrl: string;
            appName: string;
            allowedTools: Array<string>;
        }>;
        total: number;
    }>("/mcp/connections");

export const getMCPConnection = async ({
    integrationId,
}: {
    integrationId: string;
}) => {
    const response = await mcpManagerFetch<{
        id: string;
        integrationId: string;
        organizationId: string;
        status: MCP_CONNECTION_STATUS;
        provider: string;
        mcpUrl: string;
        appName: string;
        ALLOWED_TOOLS: Array<string>;
    }>(`/mcp/connections/${integrationId}`);

    return response;
};

export const updateMCPAllowedTools = async ({
    integrationId,
    allowedTools,
}: {
    integrationId: string;
    allowedTools: string[];
}) => {
    const response = await mcpManagerFetch<{
        id: string;
        integrationId: string;
        organizationId: string;
        status: MCP_CONNECTION_STATUS;
        provider: string;
        mcpUrl: string;
        appName: string;
        allowedTools: Array<string>;
    }>(`/mcp/connections/${integrationId}/allowed-tools`, {
        method: "PUT",
        body: JSON.stringify({
            allowedTools,
        }),
    });

    return response;
};

export const createMCPCustomPlugin = async (data: {
    baseUrl: string;
    protocol: CustomMCPProtocolType;
    name: string;
    description?: string;
    logoUrl?: string;
    headers?: {
        key: string;
        value: string;
    }[];
    authType: CustomMCPAuthMethodType;
    bearerToken?: string;
    apiKey?: string;
    apiKeyHeader?: string;
    basicUser?: string;
    basicPassword?: string;
    clientId?: string;
    clientSecret?: string;
    oauthScopes?: string[];
    dynamicRegistration?: boolean;
}) => {
    const response = await mcpManagerFetch<CustomMCPPlugin>(
        `/mcp/integration/custom`,
        {
            method: "POST",
            body: JSON.stringify(data),
        },
    );

    return response;
};

export const updateMCPCustomPlugin = async (
    id: string,
    data: {
        baseUrl: string;
        protocol: string;
        name: string;
        description?: string;
        logoUrl?: string;
        headers?: {
            key: string;
            value: string;
        }[];
        authType: string;
        bearerToken?: string;
        apiKey?: string;
        apiKeyHeader?: string;
        basicUser?: string;
        basicPassword?: string;
        clientId?: string;
        clientSecret?: string;
        oauthScopes?: string[];
        dynamicRegistration?: boolean;
    },
) => {
    const response = await mcpManagerFetch<CustomMCPPlugin>(
        `/mcp/integration/custom/${id}`,
        {
            method: "PUT",
            body: JSON.stringify(data),
        },
    );

    return response;
};

export const deleteMCPCustomPlugin = async (id: string) => {
    const response = await mcpManagerFetch<{}>(
        `/mcp/integration/custom/${id}`,
        {
            method: "DELETE",
            body: JSON.stringify({}),
        },
    );

    return response;
};

export const initializeOauthCustomMCPPlugin = async (
    provider: string,
    id: string,
    authMethod?: string,
) => {
    const response = await mcpManagerFetch<{ authUrl: string }>(
        `/mcp/integration/${provider}/oauth/initialize`,
        {
            method: "POST",
            body: JSON.stringify({ integrationId: id, authMethod }),
        },
    );

    return response;
};

export const connectMCPPluginWithToken = async ({
    integrationId,
    authMethod,
    secret,
    fields,
}: {
    integrationId: string;
    authMethod?: string;
    secret: string;
    fields?: Record<string, string>;
}) => {
    return mcpManagerFetch<{
        id: string;
        integrationId: string;
        provider: string;
        status: MCP_CONNECTION_STATUS;
        appName: string;
    }>(`/mcp/integration/kodusmcp/${integrationId}/token`, {
        method: "POST",
        body: JSON.stringify({ authMethod, secret, fields }),
    });
};

export const finishOauthCustomMCPPluginInstallation = async ({
    provider,
    id,
    code,
    state,
}: {
    provider: string;
    id: string;
    code: string;
    state: string;
}) => {
    const response = await mcpManagerFetch<{}>(
        `/mcp/integration/${provider}/oauth/finalize`,
        {
            method: "POST",
            body: JSON.stringify({
                integrationId: id,
                code,
                state,
            }),
        },
    );

    return response;
};
