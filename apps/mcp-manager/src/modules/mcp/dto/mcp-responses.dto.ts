import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class McpConnectionDto {
    @ApiProperty({ example: 'b6f7c3b8-2b1e-4c54-9e6a-0baf7a6a9e3a' })
    id: string;

    @ApiProperty({ example: 'org_123' })
    organizationId: string;

    @ApiProperty({ example: 'int_456' })
    integrationId: string;

    @ApiProperty({ example: 'composio' })
    provider: string;

    @ApiProperty({ example: 'ACTIVE' })
    status: string;

    @ApiProperty({ example: 'GitHub' })
    appName: string;

    @ApiPropertyOptional({ example: 'https://mcp.example.com' })
    mcpUrl?: string;

    @ApiProperty({ type: [String], example: ['repo.read', 'issue.create'] })
    allowedTools: string[];

    @ApiPropertyOptional({
        description: 'Provider-specific metadata for the connection',
        example: { connection: { id: 'ca_123' } },
    })
    metadata?: Record<string, any>;

    @ApiPropertyOptional({ example: '2026-02-05T12:00:00.000Z' })
    createdAt?: string;

    @ApiPropertyOptional({ example: '2026-02-05T12:00:00.000Z' })
    updatedAt?: string;

    @ApiPropertyOptional({ example: null })
    deletedAt?: string | null;
}

export class McpConnectionsResponseDto {
    @ApiProperty({ type: [McpConnectionDto] })
    items: McpConnectionDto[];

    @ApiProperty({ example: 1 })
    total: number;
}

export class McpRequiredParamDto {
    @ApiProperty({ example: 'apiKey' })
    name: string;

    @ApiProperty({ example: 'API Key' })
    displayName: string;

    @ApiProperty({ example: 'API key for provider access' })
    description: string;

    @ApiProperty({ example: 'string' })
    type: string;

    @ApiProperty({ example: true })
    required: boolean;
}

export class McpToolDto {
    @ApiProperty({ example: 'repo.read' })
    slug: string;

    @ApiProperty({ example: 'Read Repository' })
    name: string;

    @ApiProperty({ example: 'Reads repository contents' })
    description: string;

    @ApiProperty({ example: 'composio' })
    provider: string;

    @ApiProperty({ example: false })
    warning: boolean;
}

export class McpIntegrationDto {
    @ApiProperty({ example: 'int_456' })
    id: string;

    @ApiProperty({ example: 'GitHub' })
    name: string;

    @ApiPropertyOptional({ example: 'GitHub integration' })
    description?: string;

    @ApiPropertyOptional({ example: 'oauth2' })
    authScheme?: string;

    @ApiPropertyOptional({ example: 'GitHub' })
    appName?: string;

    @ApiPropertyOptional({ example: 'composio' })
    provider?: string;

    @ApiPropertyOptional({ example: 'https://logo.example.com' })
    logo?: string;

    @ApiPropertyOptional({ type: [String], example: ['repo.read'] })
    allowedTools?: string[];

    @ApiPropertyOptional({ example: true })
    isConnected?: boolean;

    @ApiPropertyOptional({ example: false })
    isDefault?: boolean;

    @ApiPropertyOptional({ example: 'https://api.example.com' })
    baseUrl?: string;

    @ApiPropertyOptional({ example: 'http' })
    protocol?: string;

    @ApiPropertyOptional({ example: 'api_key' })
    authType?: string;

    @ApiPropertyOptional({
        description: 'Custom headers applied to provider requests',
        example: { Authorization: 'Bearer token' },
    })
    headers?: Record<string, string>;

    @ApiPropertyOptional({ example: 'X-API-KEY' })
    apiKeyHeader?: string;

    @ApiPropertyOptional({ example: 'basic_user' })
    basicUser?: string;

    @ApiPropertyOptional({ example: true })
    active?: boolean;
}

export class McpIntegrationDetailsDto extends McpIntegrationDto {
    @ApiProperty({ type: [McpRequiredParamDto] })
    requiredParams: McpRequiredParamDto[];

    @ApiPropertyOptional({ example: true })
    isConnected?: boolean;

    @ApiPropertyOptional({ example: 'ACTIVE' })
    connectionStatus?: string;
}

export class McpMessageResponseDto {
    @ApiProperty({ example: 'Operation completed successfully' })
    message: string;
}

export class McpAllowedToolsConnectionDto {
    @ApiProperty({ example: 'b6f7c3b8-2b1e-4c54-9e6a-0baf7a6a9e3a' })
    id: string;

    @ApiProperty({ example: 'int_456' })
    integrationId: string;

    @ApiProperty({ type: [String], example: ['repo.read'] })
    allowedTools: string[];
}

export class McpAllowedToolsResponseDto {
    @ApiProperty({ example: 'Allowed tools updated successfully' })
    message: string;

    @ApiProperty({ type: McpAllowedToolsConnectionDto })
    connection: McpAllowedToolsConnectionDto;
}

export class McpOAuthInitResponseDto {
    @ApiProperty({ example: 'https://provider.example.com/oauth/authorize' })
    authUrl: string;
}

export class McpKodusIntegrationResponseDto {
    @ApiProperty({ example: 'Kodus MCP integration created successfully' })
    message: string;

    @ApiProperty({ type: McpConnectionDto })
    connection: McpConnectionDto;
}
