import { MCPConnectionStatus } from '../../mcp/entities/mcp-connection.entity';

export enum MCPProviderType {
    KODUSMCP = 'kodusmcp',
    CUSTOM = 'custom',
}

export interface MCPProviderConfig {
    apiKey: string;
    baseUrl: string;
    redirectUri?: string;
}

export interface MCPServerConfig {
    organizationId: string;
    appName: string;
    integrationId: string;
    connectedAccountId?: string;
    authConfigId?: string;
    allowedTools?: string[];
}

export interface MCPConnectionConfig {
    integrationId: string;
    organizationId: string;
    allowedTools?: string[];
    //redirectUri?: string;
    params?: { [key: string]: any };
}

export interface MCPServer {
    id: string;
    name: string;
    appName?: string;
    authConfigIds: string[];
    mcpUrl: string;
}

export interface MCPConnection {
    id: string;
    appName: string;
    authUrl?: string;
    mcpUrl?: string;
    status: string;
    allowedTools?: string[];
}

export interface MCPIntegration {
    id: string;
    name: string;
    description: string;
    authScheme: string;
    appName: string;
    provider: MCPProviderType;
    logo?: string;
    allowedTools?: string[];
    isConnected?: boolean;
    isDefault?: boolean;
    baseUrl?: string;
    protocol?: string;
    authType?: string;
    headers?: Record<string, string>;
    apiKeyHeader?: string;
    basicUser?: string;
    active?: boolean;
    /**
     * UI-safe selectable auth methods for managed integrations (e.g. Jira:
     * OAuth or API token). Lets the web app render the auth-method picker +
     * token form. Never includes secrets.
     */
    authMethods?: Array<{
        id: string;
        label?: string;
        type: string;
        default?: boolean;
        userFields?: Array<{
            name: string;
            label?: string;
            required?: boolean;
            secret?: boolean;
        }>;
    }>;
}

export interface MCPRequiredParam {
    name: string;
    displayName: string;
    description: string;
    type: string;
    required: boolean;
}

export interface MCPTool {
    slug: string;
    name: string;
    description: string;
    provider: MCPProviderType;
    warning: boolean;
    /** True when the tool's MCP `readOnlyHint` annotation marks it read-only. */
    readOnly?: boolean;
}

export interface MCPInstallIntegration {
    allowedTools?: string[];
    [key: string]: any;
}

export interface MCPInstallIntegrationResponse {
    server: MCPServer;
    connection: MCPConnection;
}

export interface MCPProvider {
    statusMap: Record<string, MCPConnectionStatus>;
    getIntegrations(
        cursor?: string,
        limit?: number,
        filters?: Record<string, any>,
    ): Promise<MCPIntegration[]>;
    getIntegration(
        integrationId: string,
        organizationId?: string,
    ): Promise<MCPIntegration>;
    getIntegrationRequiredParams(
        integrationId: string,
    ): Promise<MCPRequiredParam[]>;
    getIntegrationTools(
        integrationId: string,
        organizationId: string,
    ): Promise<MCPTool[]>;
    initiateConnection(config: MCPConnectionConfig): Promise<MCPConnection>;
    deleteConnection(connectionId: string): Promise<void>;
    initiateManagedOAuth?(
        organizationId: string,
        integrationId: string,
        authMethodId?: string,
    ): Promise<string>;
    finalizeManagedOAuth?(params: {
        organizationId: string;
        integrationId: string;
        code: string;
        state: string;
    }): Promise<void>;
}
