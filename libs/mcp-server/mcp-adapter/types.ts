/**
 * MCP adapter types — local port of the MCP-related types from the legacy flow engine's
 * `core/types/allTypes`. Copied to remove the flow-engine dependency; the MCP
 * client adapter (this folder) is the only consumer.
 */
import { z } from 'zod';

import type { MCPRegistry } from './registry';

// Branded ids in flow are nominal strings; here they are plain strings.
export type SessionId = string;
export type TenantId = string;
export type ThreadId = string;

// MCP protocol notification/result types come from the official SDK; the
// adapter only forwards them, so they are kept loose here.
export type CancelledNotification = unknown;
export type ProgressNotification = unknown;
export type InitializeResult = unknown;
/** Flow-internal context-state service — unused by the client adapter path. */
export type ContextStateService = unknown;

export interface CreateElicitationRequest {
    params: {
        message: string;
        requestedSchema?: unknown;
        timeout?: number;
    };
}

export type TransportType = 'http' | 'sse' | 'websocket' | 'stdio';

export interface CreateElicitationResult {
    action: 'continue' | 'retry' | 'cancel';
    data?: unknown;
    message?: string;
}

export interface CompleteClientCapabilities {
    tools?: {
        listChanged?: boolean;
    };
    resources?: {
        listChanged?: boolean;
        subscribe?: boolean;
    };
    prompts?: {
        listChanged?: boolean;
    };
    roots?: {
        listChanged?: boolean;
    };
    sampling?: Record<string, unknown>;
    elicitation?: Record<string, unknown>;
}

export interface TenantContext {
    tenantId: string;
    userId?: string;
    permissions: string[];
    allowedRoots: string[];
    quotas: {
        maxRequests: number;
        maxTokens: number;
        rateLimit: number;
    };
}

export interface SecurityPolicy {
    allowedUriPatterns: RegExp[];

    blockedUriPatterns: RegExp[];

    maxFileSize: number;

    preventPathTraversal: boolean;

    requireHumanApproval: boolean;
}

export interface MCPMetrics {
    connectionsTotal: number;
    connectionsActive: number;
    connectionErrors: number;

    requestsTotal: number;
    requestsSuccessful: number;
    requestsFailed: number;
    requestDuration: number[];

    toolCalls: number;
    resourceReads: number;
    promptGets: number;
    samplingRequests: number;
    elicitationRequests: number;

    securityViolations: number;
    unauthorizedAccess: number;
    pathTraversalAttempts: number;

    tenantMetrics: Record<
        string,
        {
            requests: number;
            tokensUsed: number;
            errors: number;
        }
    >;
}

export interface AuditEvent {
    timestamp: number;
    tenantId: string;
    userId?: string;
    event: string;
    resource?: string;
    success: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface MCPClientConfig {
    clientInfo: {
        name: string;
        version: string;
    };

    transport: {
        type: TransportType;

        command?: string;
        args?: string[];
        env?: Record<string, string>;
        cwd?: string;

        url?: string;
        headers?: Record<string, string>;

        timeout?: number;
        retries?: number;
        keepAlive?: boolean;
    };

    capabilities: CompleteClientCapabilities;

    security?: SecurityPolicy;

    tenant?: TenantContext;

    observability?: {
        enableMetrics: boolean;
        enableTracing: boolean;
        enableAuditLog: boolean;
        metricsInterval: number;
    };

    allowedTools?: string[];
}

export interface HumanApprovalRequest {
    type: 'sampling' | 'elicitation' | 'tool_call' | 'resource_access';
    message: string;
    context: {
        server: string;
        action: string;
        parameters?: Record<string, unknown>;
        security?: {
            riskLevel: 'low' | 'medium' | 'high';
            reason: string;
        };
    };
    timeout?: number;
}

export interface HumanApprovalResponse {
    approved: boolean;
    reason?: string;
    remember?: boolean;
    conditions?: string[];
}

export interface HumanApprovalHandler {
    requestApproval(
        request: HumanApprovalRequest,
    ): Promise<HumanApprovalResponse>;
}

export interface MCPClientEvents {
    connected: [InitializeResult];
    disconnected: [string?];
    error: [Error];

    toolsListChanged: [];
    resourcesListChanged: [];
    promptsListChanged: [];
    rootsListChanged: [];

    progress: [ProgressNotification];
    cancelled: [CancelledNotification];

    securityViolation: [AuditEvent];
    securityApprovalRequired: [HumanApprovalRequest];
    securityApprovalResponse: [HumanApprovalResponse];

    tenantQuotaExceeded: [TenantContext];
    tenantRateLimited: [TenantContext];

    metricsUpdated: [MCPMetrics];
    auditEvent: [AuditEvent];
}

export interface MCPServerConfig {
    name: string;
    type: TransportType;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
    allowedTools?: string[];
    provider?: string;
    /** Canonical capability category from the mcp-manager registry (e.g.
     *  'task-management'). Lets consumers match by capability, not display name. */
    category?: string | null;
}

export interface MCPAdapterConfig {
    servers: MCPServerConfig[];
    defaultTimeout?: number;
    maxRetries?: number;
    onError?: (error: Error, serverName: string) => void;

    toolSecurity?: {
        requireApproval?: string[];

        timeouts?: Record<string, number>;

        rateLimits?: Record<string, number>;

        permissions?: Record<string, string[]>;
    };

    toolCache?: {
        enabled?: boolean;

        ttls?: Record<string, number>;

        disabled?: string[];
    };
}

export interface MCPToolRaw {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: Record<string, unknown>;
}

export interface MCPTool extends MCPToolRaw {
    execute: (args: unknown, ctx: unknown) => Promise<unknown>;
}

export interface MCPToolRawWithServer extends MCPToolRaw {
    serverName?: string;
}

export interface MCPToolWithServer extends MCPTool {
    serverName: string;
}

export interface MCPResource {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface MCPResourceWithServer extends MCPResource {
    serverName: string;
}

export interface MCPPrompt {
    name: string;
    description?: string;
    arguments?: Array<{
        name: string;
        description?: string;
        required?: boolean;
    }>;
}

export interface MCPPromptWithServer extends MCPPrompt {
    serverName: string;
}

export interface MCPAdapter {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    ensureConnection(): Promise<void>;
    getTools(): Promise<MCPTool[]>;
    hasTool(name: string): Promise<boolean>;
    listResources(): Promise<MCPResourceWithServer[]>;
    readResource(uri: string, serverName?: string): Promise<unknown>;
    listPrompts(): Promise<MCPPromptWithServer[]>;
    getPrompt(
        name: string,
        args?: Record<string, string>,
        serverName?: string,
    ): Promise<unknown>;
    executeTool(
        name: string,
        args?: Record<string, unknown>,
        serverName?: string,
    ): Promise<unknown>;
    getMetrics(): Record<string, unknown>;
    getRegistry(): MCPRegistry;
}

export interface EngineTool {
    name: string;
    description: string;
    inputZodSchema: z.ZodSchema;
    inputSchema: unknown;
    outputSchema?: unknown;
    outputZodSchema?: z.ZodSchema;
    annotations?: Record<string, unknown>;
    title?: string;
    execute: (args: unknown, ctx: unknown) => Promise<unknown>;
}

export interface MCPRegistryOptions {
    defaultTimeout?: number;

    maxRetries?: number;

    onToolsChanged?: (serverName: string) => void;
}

export interface MCPRequestMethod {
    request(
        request: { method: string; params?: Record<string, unknown> },
        options?: { signal?: AbortSignal },
    ): Promise<unknown>;
}
