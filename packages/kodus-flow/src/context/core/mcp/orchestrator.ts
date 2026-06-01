import type {
    ContextDependency,
    ContextEvent,
    ContextPack,
    ContextTelemetry,
    LayerInputContext,
    MCPClient,
    MCPInvocationRequest,
    MCPInvocationResult,
    MCPRegistration,
    MCPToolReference,
    RuntimeContextSnapshot,
} from '../interfaces.js';

import type { MCPRegistry } from './registry.js';
import { sanitizeMCPInput } from './sanitizer.js';

export interface Logger {
    debug?(message: string, context?: Record<string, unknown>): void;
    info?(message: string, context?: Record<string, unknown>): void;
    warn?(message: string, context?: Record<string, unknown>): void;
    error?(message: string, context?: Record<string, unknown>): void;
}

export interface MCPOrchestratorOptions {
    concurrency?: number;
    maxAttempts?: number;
    retryableErrorCodes?: string[];
    logger?: Logger;
    telemetry?: {
        client?: ContextTelemetry;
        eventFactory?: (params: {
            context: MCPExecutionContext;
            report: MCPOrchestratorReport;
        }) => Partial<ContextEvent>;
    };
}

export interface MCPExecutionContext {
    pack: ContextPack;
    input: LayerInputContext;
    runtime?: RuntimeContextSnapshot;
    dependencies?: ContextDependency[];
}

export interface MCPToolExecutionRecord {
    request: MCPInvocationRequest;
    result?: MCPInvocationResult;
    error?: string;
    attempts: number;
    registration?: MCPRegistration;
    tool: MCPToolReference;
}

export interface MCPOrchestratorReport {
    startedAt: number;
    finishedAt: number;
    results: MCPToolExecutionRecord[];
    metrics: {
        successCount: number;
        failureCount: number;
        totalAttempts: number;
        totalLatencyMs: number;
    };
}

export class MCPOrchestrator {
    private readonly concurrency: number;
    private readonly maxAttempts: number;
    private readonly retryableErrorCodes: Set<string>;
    private readonly logger?: Logger;
    private readonly telemetryClient?: ContextTelemetry;
    private readonly telemetryEventFactory?: NonNullable<
        MCPOrchestratorOptions['telemetry']
    >['eventFactory'];

    constructor(
        private readonly registry: MCPRegistry,
        private readonly client: MCPClient,
        options: MCPOrchestratorOptions = {},
    ) {
        this.concurrency = Math.max(1, options.concurrency ?? 1);
        this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
        this.retryableErrorCodes = new Set(
            options.retryableErrorCodes ?? ['ECONNRESET', 'ETIMEDOUT'],
        );
        this.logger = options.logger;
        this.telemetryClient = options.telemetry?.client;
        this.telemetryEventFactory = options.telemetry?.eventFactory;
    }

    private isMCPToolReference(value: unknown): value is MCPToolReference {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Record<string, unknown>;
        return (
            typeof candidate.mcpId === 'string' &&
            typeof candidate.toolName === 'string'
        );
    }

    private extractToolDependencies(
        dependencies?: ContextDependency[],
    ): MCPToolReference[] {
        if (!dependencies?.length) {
            return [];
        }

        const unique = new Map<string, MCPToolReference>();

        for (const dependency of dependencies) {
            if (!dependency) {
                continue;
            }

            if (dependency.type !== 'mcp' && dependency.type !== 'tool') {
                continue;
            }

            let reference: MCPToolReference | undefined;

            if (this.isMCPToolReference(dependency.descriptor)) {
                const descriptor = dependency.descriptor as MCPToolReference;
                reference = {
                    ...descriptor,
                    metadata: {
                        ...(descriptor.metadata ?? {}),
                        ...(dependency.metadata ?? {}),
                    },
                };
            } else if (dependency.metadata) {
                const meta = dependency.metadata as Record<string, unknown>;
                if (
                    typeof meta.mcpId === 'string' &&
                    typeof meta.toolName === 'string'
                ) {
                    reference = {
                        mcpId: meta.mcpId,
                        toolName: meta.toolName,
                        description: meta.description as string | undefined,
                        metadata: meta,
                    };
                }
            }

            if (!reference && typeof dependency.id === 'string') {
                const [mcpId, toolName] = dependency.id.split('|', 2);
                if (mcpId && toolName) {
                    reference = {
                        mcpId,
                        toolName,
                        metadata: dependency.metadata,
                    };
                }
            }

            if (!reference) {
                continue;
            }

            const key = `${reference.mcpId}|${reference.toolName}`;
            const existing = unique.get(key);
            if (existing) {
                const mergedMetadata = {
                    ...(existing.metadata ?? {}),
                    ...(reference.metadata ?? {}),
                };
                unique.set(key, {
                    ...existing,
                    ...reference,
                    metadata: Object.keys(mergedMetadata).length
                        ? mergedMetadata
                        : undefined,
                });
            } else {
                unique.set(key, reference);
            }
        }

        return Array.from(unique.values());
    }

    async executeRequiredTools({
        pack,
        input,
        runtime,
        dependencies: explicitDependencies,
    }: MCPExecutionContext): Promise<MCPOrchestratorReport> {
        // Usa dependencies explícitas se fornecidas, senão usa do pack
        const dependencies = explicitDependencies ?? pack.dependencies ?? [];
        const required = this.extractToolDependencies(dependencies);

        if (!required.length) {
            const now = Date.now();
            return {
                startedAt: now,
                finishedAt: now,
                results: [],
                metrics: {
                    successCount: 0,
                    failureCount: 0,
                    totalAttempts: 0,
                    totalLatencyMs: 0,
                },
            };
        }

        const results: Array<MCPToolExecutionRecord | undefined> = new Array(
            required.length,
        );
        let index = 0;
        const startedAt = Date.now();

        const runWorker = async (): Promise<void> => {
            while (true) {
                const currentIndex = index++;
                if (currentIndex >= required.length) {
                    break;
                }

                const toolRef = required[currentIndex];
                if (!toolRef) {
                    continue;
                }

                const registration = this.registry.get(toolRef.mcpId);

                if (!registration) {
                    const error = `MCP ${toolRef.mcpId} not registered`;
                    this.logger?.warn?.('mcp.tool.missing', {
                        tool: toolRef.toolName,
                        mcpId: toolRef.mcpId,
                    });

                    results[currentIndex] = {
                        request: {
                            registry: {
                                id: toolRef.mcpId,
                                endpoint: '',
                                status: 'unavailable',
                                tools: [],
                            } as MCPRegistration,
                            tool: toolRef,
                            input: {},
                        },
                        tool: toolRef,
                        attempts: 0,
                        error,
                    };
                    continue;
                }

                const record = await this.invokeWithRetry(
                    registration,
                    toolRef,
                    pack,
                    input,
                    runtime,
                );
                results[currentIndex] = record;
            }
        };

        const workers = Array.from({ length: this.concurrency }, runWorker);
        await Promise.all(workers);

        const finishedAt = Date.now();
        const completedResults = results.map((record, index) => {
            if (record) {
                return record;
            }

            const tool = required[index];
            if (!tool) {
                return {
                    request: {
                        registry: {
                            id: 'unknown',
                            endpoint: '',
                            status: 'unavailable',
                            tools: [],
                        } as MCPRegistration,
                        tool: {
                            mcpId: 'unknown',
                            toolName: 'unknown',
                        },
                        input: {},
                    },
                    error: 'MCP invocation not executed',
                    attempts: 0,
                    tool: {
                        mcpId: 'unknown',
                        toolName: 'unknown',
                    },
                };
            }
            return {
                request: {
                    registry: {
                        id: tool.mcpId,
                        endpoint: '',
                        status: 'unavailable',
                        tools: [],
                    } as MCPRegistration,
                    tool,
                    input: {},
                },
                error: 'MCP invocation not executed',
                attempts: 0,
                tool,
            } as MCPToolExecutionRecord;
        });

        const metrics = completedResults.reduce(
            (acc, record) => {
                acc.totalAttempts += record.attempts;
                if (record.result?.success) {
                    acc.successCount += 1;
                    acc.totalLatencyMs += record.result.latencyMs;
                } else {
                    acc.failureCount += 1;
                    acc.totalLatencyMs += record.result?.latencyMs ?? 0;
                }
                return acc;
            },
            {
                successCount: 0,
                failureCount: 0,
                totalAttempts: 0,
                totalLatencyMs: 0,
            },
        );

        const report = {
            startedAt,
            finishedAt,
            results: completedResults,
            metrics,
        };

        if (this.telemetryClient) {
            const hasFailure = metrics.failureCount > 0;
            const runtimeUserId =
                runtime?.metadata && typeof runtime.metadata.userId === 'string'
                    ? (runtime.metadata.userId as string)
                    : undefined;
            const contextUserId =
                input.runtimeContext?.metadata &&
                typeof input.runtimeContext.metadata.userId === 'string'
                    ? (input.runtimeContext.metadata.userId as string)
                    : undefined;

            const baseEvent: ContextEvent = {
                type: hasFailure ? 'ERROR' : 'DELIVERY',
                sessionId:
                    runtime?.sessionId ??
                    input.runtimeContext?.sessionId ??
                    'unknown-session',
                tenantId:
                    runtime?.tenantId ??
                    input.runtimeContext?.tenantId ??
                    'unknown-tenant',
                packId: pack.id,
                userId: runtimeUserId ?? contextUserId,
                budget: pack.budget,
                tokensUsed: pack.budget.usage,
                latencyMs: metrics.totalLatencyMs,
                metadata: {
                    toolResults: completedResults.map((result) => ({
                        tool: result.tool.toolName,
                        success: result.result?.success ?? false,
                        error: result.error,
                        latencyMs: result.result?.latencyMs,
                    })),
                },
                timestamp: Date.now(),
            };

            const mergedEvent = {
                ...baseEvent,
                ...(this.telemetryEventFactory?.({
                    context: { pack, input, runtime },
                    report,
                }) ?? {}),
            };

            await this.telemetryClient.record(mergedEvent);
        }

        return report;
    }

    private async invokeWithRetry(
        registration: MCPRegistration,
        tool: MCPToolReference,
        pack: ContextPack,
        input: LayerInputContext,
        runtime?: RuntimeContextSnapshot,
    ): Promise<MCPToolExecutionRecord> {
        let attempts = 0;
        let lastError: string | undefined;
        let lastResult: MCPInvocationResult | undefined;
        let lastRequest: MCPInvocationRequest | undefined;

        while (attempts < this.maxAttempts) {
            attempts += 1;

            try {
                const request: MCPInvocationRequest = {
                    registry: registration,
                    tool,
                    input: sanitizeMCPInput({
                        taskIntent: input.taskIntent,
                        domain: input.domain,
                        packId: pack.id,
                        agent:
                            (pack.metadata?.agentIdentity as unknown) ??
                            input.deliveryRequest?.agentIdentity,
                    }),
                    runtimeMetadata: {
                        packLayers: pack.layers.map((layer) => layer.kind),
                        sessionId: runtime?.sessionId,
                        tenantId: runtime?.tenantId,
                        threadId: runtime?.threadId,
                    },
                };

                lastRequest = request;

                const result = await this.client.invoke(request);
                lastResult = result;

                if (result.success) {
                    this.logger?.info?.('mcp.tool.success', {
                        tool: tool.toolName,
                        latencyMs: result.latencyMs,
                    });
                    return {
                        request,
                        result,
                        attempts,
                        registration,
                        tool,
                    };
                }

                lastError =
                    result.error?.message ??
                    `Tool ${tool.toolName} returned failure`;

                this.logger?.warn?.('mcp.tool.failure', {
                    tool: tool.toolName,
                    attempts,
                    error: lastError,
                });

                if (
                    !result.error?.code ||
                    !this.retryableErrorCodes.has(result.error.code)
                ) {
                    break;
                }
            } catch (error) {
                const nodeError = error as NodeJS.ErrnoException;
                lastError = nodeError?.message ?? String(error);
                const errorCode =
                    typeof nodeError?.code === 'string'
                        ? nodeError.code
                        : undefined;
                this.logger?.error?.('mcp.tool.exception', {
                    tool: tool.toolName,
                    attempts,
                    error: lastError,
                    code: errorCode,
                });

                if (!errorCode || !this.retryableErrorCodes.has(errorCode)) {
                    break;
                }
            }
        }

        return {
            request:
                lastRequest ??
                ({
                    registry: registration,
                    tool,
                    input: {},
                } as MCPInvocationRequest),
            result: lastResult,
            error: lastError,
            attempts,
            registration,
            tool,
        };
    }
}
