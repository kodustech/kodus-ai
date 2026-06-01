export enum MCPIntegrationAuthType {
    NONE = 'none',
    API_KEY = 'api_key',
    BASIC = 'basic',
    BEARER_TOKEN = 'bearer_token',
    OAUTH2 = 'oauth2',
}

export enum MCPIntegrationProtocol {
    HTTP = 'http',
    SSE = 'sse',
}

export enum MCPIntegrationOAuthStatus {
    ACTIVE = 'active',
    PENDING = 'pending',
    INACTIVE = 'inactive',
}
