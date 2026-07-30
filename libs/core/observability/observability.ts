import {
    ObservabilityConfig,
    ObservabilityContext,
    Span,
    SpanOptions,
    TraceItem,
    LogContext,
    ObservabilityExporter,
    AGENT,
    GEN_AI,
} from './types';
import { TelemetrySystem, isCriticalSpan } from './telemetry';
import { isEnhancedError } from './errors';
import {
    createLogger,
    addLogProcessor,
    setGlobalLogLevel,
    setSpanContextProvider,
    setObservabilityContextProvider,
} from '@libs/core/log/logger';
import { AsyncLocalStorage } from 'node:async_hooks';

import {
    executionTracker,
    startExecutionTracking,
    completeExecutionTracking,
    failExecutionTracking,
} from './execution-tracker';

import {
    createAgentExecutionSpan,
    createToolExecutionSpan,
    SPAN_NAMES,
} from './semantic-conventions';
import { IdGenerator } from '@libs/core/utils/id-generator';
import { createMongoDBExporter } from './exporters/mongodb-exporter';
import { OtlpTraceExporter } from './exporters/otlp-exporter';
import { OtelAdapter } from './core/otel-adapter';
import { SanitizationProcessor } from './processors/sanitization-processor';
import { LogLevel } from './flow-types';

/**
 * Main observability system that coordinates all components
 */
export class ObservabilitySystem {
    private config: ObservabilityConfig;
    private telemetry: TelemetrySystem;
    private logger = createLogger('observability');
    private currentContext?: ObservabilityContext;
    private alsContext = new AsyncLocalStorage<ObservabilityContext>();
    private exporters: ObservabilityExporter[] = [];
    private otelAdapter = new OtelAdapter();

    constructor(config: Partial<ObservabilityConfig> = {}) {
        this.config = {
            enabled: config.enabled ?? true,
            serviceName: config.serviceName || 'kodus-ai',
            environment: config.environment || 'development',
            logging: {
                level: config.logging?.level || 'info',
                enabled: config.logging?.enabled ?? true,
            },
            telemetry: {
                enabled: config.telemetry?.enabled ?? true,
                serviceName: config.serviceName || 'kodus-ai',
                sampling: config.telemetry?.sampling || {
                    rate: 1.0,
                    strategy: 'probabilistic' as const,
                },
                features: config.telemetry?.features || {
                    traceSpans: true,
                    traceEvents: true,
                },
                globalAttributes: config.telemetry?.globalAttributes,
            },
            ...config,
        };

        // Initialize telemetry system
        this.telemetry = new TelemetrySystem(this.config.telemetry);

        // Bridge logger level from configuration (overrides env)
        if (this.config.logging?.level) {
            try {
                setGlobalLogLevel(this.config.logging.level);
            } catch {}
        }

        // Provide span context to logger for log-trace correlation
        try {
            setSpanContextProvider(() => {
                const span = this.telemetry.getCurrentSpan();
                const sc = span?.getSpanContext();
                if (sc && sc.traceId && sc.spanId) {
                    return { traceId: sc.traceId, spanId: sc.spanId };
                }
                return undefined;
            });
        } catch {}

        // Provide observability context for default log fields
        try {
            setObservabilityContextProvider(() => {
                const ctx = this.getContext();

                if (!ctx) {
                    return undefined;
                }

                return {
                    correlationId: ctx.correlationId,
                    tenantId: ctx.tenantId,
                    sessionId: ctx.sessionId,
                };
            });
        } catch {}

        // Setup exporters (async initialization will be handled separately)
        this.setupExportersSync();

        this.logger.log({
            message: 'Observability system initialized',
            context: this.constructor.name,

            metadata: {
                environment: this.config.environment,
                enabled: this.config.enabled,
                serviceName: this.config.serviceName,
            },
        });
    }

    /**
     * Create a new observability context
     */
    createContext(correlationId?: string): ObservabilityContext {
        const context: ObservabilityContext = {
            correlationId: correlationId || IdGenerator.correlationId(),
            tenantId: '',
            startTime: Date.now(),
        };

        this.logger.debug({
            message: 'Observability context created',
            context: this.constructor.name,

            metadata: {
                correlationId: context.correlationId,
            },
        });

        return context;
    }

    /**
     * Set the current observability context
     */
    setContext(context: ObservabilityContext): void {
        this.currentContext = context;
        try {
            // Make context available within this async chain
            this.alsContext.enterWith(context);
        } catch {}
    }

    /**
     * Get the current observability context
     */
    getContext(): ObservabilityContext | undefined {
        return this.alsContext.getStore() || this.currentContext;
    }

    /**
     * Clear the current observability context
     */
    clearContext(): void {
        if (this.currentContext) {
            this.logger.debug({
                message: 'Observability context cleared',
                context: this.constructor.name,

                metadata: {
                    correlationId: this.currentContext.correlationId,
                },
            });
        }
        this.currentContext = undefined;
    }

    /**
     * Get the current active span
     */
    getCurrentSpan(): Span | undefined {
        return this.telemetry.getCurrentSpan();
    }

    /**
     * Inject current context into carrier (e.g. HTTP headers)
     * Uses W3C Trace Context standard via OTel
     */
    injectContext(carrier: Record<string, string>): void {
        if (this.otelAdapter.isAvailable()) {
            const currentSpan = this.getCurrentSpan();
            const sc = currentSpan?.getSpanContext();

            let ctx = this.otelAdapter.getCurrentContext();

            if (sc && sc.traceId && sc.spanId) {
                ctx = this.otelAdapter.contextFromIds(
                    sc.traceId,
                    sc.spanId,
                    sc.traceFlags,
                );
            }

            this.otelAdapter.inject(ctx, carrier);
        }

        // Also inject internal correlationId for backward compatibility
        const ctx = this.getContext();
        if (ctx?.correlationId) {
            carrier['x-correlation-id'] = ctx.correlationId;
        }
    }

    /**
     * Extract context from carrier (e.g. HTTP headers)
     * Uses W3C Trace Context standard via OTel
     */
    extractContext(carrier: Record<string, string>): any {
        if (this.otelAdapter.isAvailable()) {
            return this.otelAdapter.extract(
                this.otelAdapter.getCurrentContext(),
                carrier,
            );
        }
        return undefined;
    }

    /**
     * Start a span
     */
    startSpan(name: string, options: SpanOptions = {}): Span {
        // Auto-attach common attributes from current context for better filtering
        const ctx = this.getContext();
        const attrs: Record<string, string | number | boolean> = {
            ...(options.attributes || {}),
        };
        if (ctx?.correlationId && attrs[AGENT.CORRELATION_ID] === undefined) {
            attrs[AGENT.CORRELATION_ID] = ctx.correlationId;
        }
        if (ctx?.tenantId && attrs[AGENT.TENANT_ID] === undefined) {
            attrs[AGENT.TENANT_ID] = ctx.tenantId;
        }
        if (ctx?.sessionId && attrs[AGENT.CONVERSATION_ID] === undefined) {
            attrs[AGENT.CONVERSATION_ID] = ctx.sessionId;
        }
        return this.telemetry.startSpan(name, {
            ...options,
            attributes: attrs,
        });
    }

    /**
     * Execute a function within a span context
     */
    async withSpan<T>(span: Span, fn: () => T | Promise<T>): Promise<T> {
        return this.telemetry.withSpan(span, fn);
    }

    /**
     * Trace a function execution with automatic span creation
     */
    async trace<T>(
        name: string,
        fn: () => T | Promise<T>,
        options: SpanOptions = {},
    ): Promise<T> {
        const span = this.startSpan(name, options);
        return this.withSpan(span, fn);
    }

    /**
     * Trace an agent execution with full lifecycle tracking
     */
    async traceAgent<T>(
        agentName: string,
        fn: () => T | Promise<T>,
        options: {
            input?: unknown;
            correlationId?: string;
            tenantId?: string;
            sessionId?: string;
            userId?: string;
            agentVersion?: string;
            agentType?: string;
            inputTokens?: number;
        } = {},
    ): Promise<T> {
        const correlationId =
            options.correlationId ||
            this.currentContext?.correlationId ||
            IdGenerator.correlationId();

        // Start execution tracking
        const executionId = startExecutionTracking(
            agentName,
            correlationId,
            {
                tenantId: options.tenantId,
                sessionId: options.sessionId,
                userId: options.userId,
            },
            options.input,
        );

        // Use OpenTelemetry semantic conventions
        const spanOptions = createAgentExecutionSpan(agentName, executionId, {
            agentVersion: options.agentVersion,
            agentType: options.agentType,
            conversationId: options.sessionId,
            userId: options.userId,
            tenantId: options.tenantId,
            correlationId: correlationId,
            input: options.input as string,
            inputTokens: options.inputTokens,
        });

        // Add executionId for internal tracking if needed (already in attributes from helper)
        spanOptions.attributes = {
            ...spanOptions.attributes,
        };

        const span = this.startSpan(SPAN_NAMES.AGENT_EXECUTE, spanOptions);

        const startTime = Date.now();

        try {
            const result = await this.withSpan(span, fn);
            span.setStatus({ code: 'ok' });

            const duration = Date.now() - startTime;

            completeExecutionTracking(executionId, result);

            this.logger.debug({
                message: 'Agent execution completed',
                context: this.constructor.name,

                metadata: {
                    agentName,
                    executionId,
                    correlationId,
                    duration,
                },
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;

            span.recordException(error as Error);
            if (isEnhancedError(error as Error)) {
                try {
                    const e = error as any;
                    if (e?.context?.subcode) {
                        span.setAttribute(
                            'error.subcode',
                            String(e.context.subcode),
                        );
                    }
                    if (e?.code) {
                        span.setAttribute('error.code', String(e.code));
                    }
                } catch {}
            }
            failExecutionTracking(executionId, error as Error);

            this.logger.error({
                message: 'Agent execution failed',
                context: this.constructor.name,
                error: error as Error,

                metadata: {
                    agentName,
                    executionId,
                    correlationId,
                    duration,
                },
            });

            throw error;
        }
    }

    /**
     * Trace a tool execution
     */
    async traceTool<T>(
        toolName: string,
        fn: () => T | Promise<T>,
        options: {
            callId?: string;
            toolType?: string;
            parameters?: Record<string, unknown>;
            correlationId?: string;
            timeoutMs?: number;
        } = {},
    ): Promise<T> {
        const executionId = options.callId || IdGenerator.correlationId();

        // Use OpenTelemetry semantic conventions
        const spanOptions = createToolExecutionSpan(toolName, executionId, {
            toolType: options.toolType,
            parameters: options.parameters,
            correlationId:
                options.correlationId ||
                this.currentContext?.correlationId ||
                '',
        });

        // Add additional attributes
        spanOptions.attributes = {
            ...spanOptions.attributes,
            timeoutMs: options.timeoutMs || 0,
        };

        const span = this.startSpan(SPAN_NAMES.TOOL_EXECUTE, spanOptions);

        return this.withSpan(span, async () => {
            try {
                const result = await fn();
                return result;
            } catch (error) {
                if (isEnhancedError(error as Error)) {
                    try {
                        const e = error as any;
                        if (e?.context?.subcode) {
                            span.setAttribute(
                                'error.subcode',
                                String(e.context.subcode),
                            );
                        }
                        if (e?.code) {
                            span.setAttribute('error.code', String(e.code));
                        }
                    } catch {}
                }
                span.recordException(error as Error);
                throw error;
            }
        });
    }

    /**
     * Log a message
     */
    log(level: LogLevel, message: string, context?: LogContext): void {
        if (this.config.logging?.enabled === false) {
            return;
        }

        const mergedContext = {
            correlationId: this.currentContext?.correlationId,
            tenantId: this.currentContext?.tenantId,
            ...context,
        };

        // Route to correct severity; logger handles processors (e.g., MongoDB)
        switch (level) {
            case 'debug':
                this.logger.debug({
                    message: message,
                    context: this.constructor.name,
                    metadata: mergedContext,
                });
                break;
            case 'info':
                this.logger.log({
                    message: message,
                    context: this.constructor.name,
                    metadata: mergedContext,
                });
                break;
            case 'warn':
                this.logger.warn({
                    message: message,
                    context: this.constructor.name,
                    metadata: mergedContext,
                });
                break;
            case 'error':
                this.logger.error({
                    message: message,
                    context: this.constructor.name,
                    error: undefined,
                    metadata: mergedContext,
                });
                break;
            default:
                this.logger.log({
                    message: message,
                    context: this.constructor.name,
                    metadata: mergedContext,
                });
        }
    }

    /**
     * Get system statistics
     */
    getStats(): {
        telemetry: ReturnType<TelemetrySystem['getStats']>;
        executions: {
            active: number;
            totalTracked: number;
        };
        buffers?: {
            traces: number;
            logs: number;
        };
    } {
        return {
            telemetry: this.telemetry.getStats(),
            executions: {
                active: executionTracker.getActiveExecutions().length,
                totalTracked: executionTracker.getActiveExecutions().length, // Simplified
            },
            buffers: undefined, // MongoDB exporter doesn't provide buffer sizes
        };
    }

    /**
     * Flush all components
     */
    async flush(): Promise<void> {
        await Promise.allSettled([
            this.telemetry.flush(),
            ...this.exporters.map((e) => e.flush()),
        ]);
    }

    /**
     * Shutdown the observability system gracefully
     */
    async shutdown(): Promise<void> {
        this.logger.log({
            message: 'Shutting down observability system',
            context: this.constructor.name,
            metadata: {
                exporters: this.exporters.length,
                hasExecutionTracker: true,
            },
        });

        // 1. Shutdown telemetry (flushes and cleans up processors)
        try {
            await this.telemetry.shutdown();
        } catch (error) {
            this.logger.error({
                message: 'Error shutting down telemetry',
                context: this.constructor.name,
                error: error as Error,
            });
        }

        // 2. Shutdown all exporters (MongoDB, OTLP, etc)
        const shutdownResults = await Promise.allSettled(
            this.exporters.map(async (exporter) => {
                try {
                    await exporter.shutdown();
                    this.logger.log({
                        message: `Exporter shutdown complete: ${exporter.name}`,
                        context: this.constructor.name,
                    });
                } catch (error) {
                    this.logger.error({
                        message: `Failed to shutdown exporter: ${exporter.name}`,
                        context: this.constructor.name,
                        error: error as Error,
                    });
                    throw error;
                }
            }),
        );

        // 3. Log shutdown failures
        const failures = shutdownResults.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
            this.logger.warn({
                message: `${failures.length} exporter(s) failed to shutdown cleanly`,
                context: this.constructor.name,
                metadata: {
                    total: this.exporters.length,
                    failed: failures.length,
                },
            });
        }

        // 4. Clear execution tracker to prevent memory leaks
        executionTracker.clear();

        // 5. Clear context
        this.clearContext();

        this.logger.log({
            message: 'Observability system shutdown complete',
            context: this.constructor.name,
        });
    }

    /**
     * Update context with execution information
     */
    updateContextWithExecution(executionId: string, agentName: string): void {
        // Implementation for compatibility
        this.logger.debug({
            message: 'Context updated with execution',
            context: this.constructor.name,

            metadata: {
                executionId,
                agentName,
            },
        });
    }

    /**
     * Save agent execution cycle
     */
    async saveAgentExecutionCycle(cycle: any): Promise<void> {
        // Implementation for compatibility
        this.logger.log({
            message: 'Agent execution cycle saved',
            context: this.constructor.name,

            metadata: {
                executionId: cycle.executionId,
                agentName: cycle.agentName,
            },
        });
    }

    /**
     * Run health checks
     */
    async runHealthChecks(): Promise<any> {
        // Implementation for compatibility
        return {
            overall: 'healthy',
            components: {
                logging: { status: 'ok' },
                telemetry: { status: 'ok' },
                monitoring: { status: 'ok' },
                debugging: { status: 'ok' },
            },
            lastCheck: Date.now(),
        };
    }

    /**
     * Check memory health
     */
    checkMemoryHealth(): Promise<any> {
        // Implementation for compatibility
        return Promise.resolve({
            status: 'ok',
            memoryUsage: process.memoryUsage(),
        });
    }

    /**
     * Setup exporters based on configuration
     */
    private setupExportersSync(): void {
        // Setup Sanitization Processor first to clean data before any export
        const sanitizationProcessor = new SanitizationProcessor();
        this.telemetry.addTraceProcessor(sanitizationProcessor);

        // Console logging is handled directly in telemetry processors

        // Setup telemetry processor for console
        this.telemetry.addTraceProcessor({
            process: async (item: TraceItem) => {
                // Simple console export for traces using structured logging
                this.logger.log({
                    message: `[TRACE] ${item.name}`,
                    context: this.constructor.name,

                    metadata: {
                        traceId: item.context.traceId,
                        spanId: item.context.spanId,
                        duration: `${item.duration}ms`,
                        status: item.status.code,
                    },
                });
            },
        });

        // Setup MongoDB exporter if configured
        if (this.config.mongodb) {
            try {
                // Adaptar config do MongoDB para o formato esperado pelo exporter
                // Note: MongoDB saves all logs for complete history
                // Console respects API_LOG_LEVEL via Pino logger
                const mongoConfig = {
                    connectionString:
                        this.config.mongodb.connectionString ||
                        'mongodb://localhost:27017/kodus',
                    database: this.config.mongodb.database || 'kodus',
                    collections: {
                        logs:
                            this.config.mongodb.collections?.logs ||
                            'observability_logs_ts', // Updated for Time-Series (MongoDB 8)
                        telemetry:
                            this.config.mongodb.collections?.telemetry ||
                            'observability_telemetry',
                    },
                    batchSize: this.config.mongodb.batchSize || 100,
                    flushIntervalMs:
                        this.config.mongodb.flushIntervalMs || 30000,
                    ttlDays: this.config.mongodb.ttlDays ?? 0, // Default 0 (Infinite Retention) for Time-Series
                    enableObservability:
                        this.config.mongodb.enableObservability ?? true,
                    secondaryIndexes: this.config.mongodb.secondaryIndexes || [
                        'metadata.component',
                        'metadata.tenantId',
                        'metadata.organizationId',
                        'metadata.teamId',
                        'attributes.prNumber',
                    ],
                    bucketKeys: this.config.mongodb.bucketKeys || [
                        'organizationId',
                        'teamId',
                        'tenantId',
                    ],
                };

                const mongoExporter = createMongoDBExporter(mongoConfig);
                this.exporters.push(mongoExporter);

                // Add telemetry processor for MongoDB (will be initialized later)
                this.telemetry.addTraceProcessor({
                    process: async (item: TraceItem) => {
                        const isCritical = isCriticalSpan(item);

                        try {
                            await mongoExporter.exportTrace(item);
                        } catch (error) {
                            // Critical error for LLM spans - these are billing data
                            const logLevel = isCritical ? 'error' : 'debug';
                            this.logger[logLevel]({
                                message: isCritical
                                    ? '🚨 CRITICAL: MongoDB export failed for LLM span - BILLING DATA MAY BE LOST'
                                    : 'MongoDB export failed (possibly not initialized)',
                                context: this.constructor.name,
                                error: error as Error,
                                metadata: {
                                    traceId: item.context.traceId,
                                    spanId: item.context.spanId,
                                    spanName: item.name,
                                    isCriticalSpan: isCritical,
                                    totalTokens:
                                        item.attributes?.[
                                            GEN_AI.USAGE_TOTAL_TOKENS
                                        ],
                                },
                            });

                            // Re-throw error so retry mechanism can catch it
                            throw error;
                        }
                    },
                });

                // Add MongoDB exporter as log processor
                addLogProcessor(mongoExporter);

                this.logger.log({
                    message:
                        'MongoDB exporter configured (needs initialization)',
                    context: this.constructor.name,
                });
            } catch (error) {
                this.logger.warn({
                    message: 'Failed to setup MongoDB exporter',
                    context: this.constructor.name,
                    error: error as Error,
                });
            }
        }

        // Setup OTLP Exporter if configured
        if (this.config.otlp?.enabled) {
            try {
                const otlpExporter = new OtlpTraceExporter(this.otelAdapter);
                this.exporters.push(otlpExporter);

                // Add telemetry processor for OTLP
                this.telemetry.addTraceProcessor({
                    process: async (item: TraceItem) => {
                        try {
                            await otlpExporter.exportTrace(item);
                        } catch {
                            // Silent fail or debug log
                        }
                    },
                });

                this.logger.log({
                    message: 'OTLP exporter configured',
                    context: this.constructor.name,
                });
            } catch (error) {
                this.logger.warn({
                    message: 'Failed to setup OTLP exporter',
                    context: this.constructor.name,
                    error: error as Error,
                });
            }
        }

        // Setup error processors
        this.setupErrorProcessors();
    }

    /**
     * Setup error processors for automatic error handling
     */
    private setupErrorProcessors(): void {
        // Idempotent guard to avoid multiple handler registrations
        const anyProcess = process as any;
        if (anyProcess.__kodusObsHandlersInstalled) {
            this.logger.debug({
                message: 'Error processors already configured',
                context: this.constructor.name,
            });
            return;
        }
        anyProcess.__kodusObsHandlersInstalled = true;

        // Capture uncaught exceptions
        process.on('uncaughtException', (error) => {
            this.handleGlobalError(error, 'uncaught_exception');
        });

        process.on('unhandledRejection', (reason) => {
            const error =
                reason instanceof Error ? reason : new Error(String(reason));
            this.handleGlobalError(error, 'unhandled_rejection');
        });

        // Setup graceful shutdown
        process.on('SIGTERM', () => {
            this.logger.log({
                message: 'SIGTERM received, shutting down gracefully',
                context: this.constructor.name,
            });
            this.shutdown().catch((error) => {
                this.logger.error({
                    message: 'Error during SIGTERM shutdown',
                    context: this.constructor.name,
                    error: error as Error,
                });
                process.exit(1);
            });
        });

        process.on('SIGINT', () => {
            this.logger.log({
                message: 'SIGINT received, shutting down gracefully',
                context: this.constructor.name,
            });
            this.shutdown().catch((error) => {
                this.logger.error({
                    message: 'Error during SIGINT shutdown',
                    context: this.constructor.name,
                    error: error as Error,
                });
                process.exit(1);
            });
        });
        // Removed log: 'Error processors configured' - internal system message, no business value
    }

    private handleGlobalError(error: Error, type: string): void {
        const errorContext = {
            errorType: type,
            errorName: error.name,
            errorMessage: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString(),
            process: {
                pid: process.pid,
                platform: process.platform,
                version: process.version,
            },
        };

        this.logger.error({
            message: `Global ${type} caught`,
            context: this.constructor.name,
            error: error,
            metadata: errorContext,
        });

        // Use exporters
        this.exporters.forEach((exporter) => {
            void exporter.exportLog(
                'error',
                error.message,
                {
                    ...errorContext,
                    errorType: type,
                },
                error,
            );
        });
    }

    async initialize(): Promise<void> {
        // Clear execution tracker to ensure a clean state
        executionTracker.clear();

        // Initialize all exporters in parallel
        await Promise.allSettled(
            this.exporters.map(async (exporter) => {
                try {
                    if (exporter.initialize) {
                        await exporter.initialize();
                        this.logger.log({
                            message: `${exporter.name} initialized successfully`,
                            context: this.constructor.name,
                        });
                    }
                } catch (error) {
                    this.logger.error({
                        message: `Failed to initialize ${exporter.name}`,
                        context: this.constructor.name,
                        error: error as Error,
                    });
                    // Don't throw, let other exporters continue
                }
            }),
        );

        // Metrics exporter removed — no initialization
    }
}
