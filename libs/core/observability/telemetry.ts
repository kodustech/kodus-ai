import {
    TelemetryConfig,
    Span,
    SpanOptions,
    TraceItem,
    SpanProcessor,
    GEN_AI,
} from './types';
import { SimpleTracer } from './core/tracer';
import { createLogger } from '@libs/core/log/logger';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Determines if a span represents an LLM/AI operation based on OpenTelemetry semantic conventions.
 * LLM spans are critical for billing and must be handled with higher reliability guarantees.
 *
 * @param span - The trace item to check
 * @returns true if the span contains Gen AI usage data (billing critical)
 */
export function isLLMSpan(span: TraceItem): boolean {
    return !!span.attributes[GEN_AI.USAGE_TOTAL_TOKENS];
}

/**
 * Determines if a span is critical (requires synchronous processing and higher reliability).
 * Currently, only LLM spans are considered critical due to billing implications.
 *
 * @param span - The trace item to check
 * @returns true if the span is critical (LLM/billing data)
 */
export function isCriticalSpan(span: TraceItem): boolean {
    return isLLMSpan(span);
}

/**
 * Simple and robust telemetry system
 */
export class TelemetrySystem {
    private config: TelemetryConfig;
    private tracer: SimpleTracer;
    private logger = createLogger('telemetry');
    private processors: SpanProcessor[] = [];
    private currentSpan?: Span;
    private als = new AsyncLocalStorage<Span>();

    constructor(config: Partial<TelemetryConfig> = {}) {
        this.config = {
            enabled: true,
            serviceName: 'kodus-ai',
            sampling: {
                rate: 1.0,
                strategy: 'probabilistic',
                ...config.sampling,
            },
            features: {
                traceSpans: true,
                traceEvents: true,
                ...config.features,
            },
            globalAttributes: config.globalAttributes || {},
            ...config,
        };

        this.tracer = new SimpleTracer();

        this.logger.log({
            message: 'Telemetry system initialized',
            context: this.constructor.name,

            metadata: {
                enabled: this.config.enabled,
                serviceName: this.config.serviceName,
                samplingRate: this.config.sampling?.rate ?? 1.0,
            },
        });
    }

    /**
     * Check if telemetry is enabled and should sample
     */
    isEnabled(): boolean {
        if (!this.config.enabled) {
            return false;
        }

        if (!this.config.features?.traceSpans) {
            return false;
        }

        if (this.config.sampling?.strategy === 'never') {
            return false;
        }

        if (this.config.sampling?.strategy === 'always') {
            return true;
        }

        // Base decision only – final sampling may be refined per-span in startSpan
        return true;
    }

    /**
     * Start a new span
     */
    startSpan(name: string, options: SpanOptions = {}): Span {
        if (!this.isEnabled()) {
            return this.createNoOpSpan();
        }

        // Rule-based sampling per operation name
        const baseRate = this.config.sampling?.rate ?? 1.0;
        let rate = baseRate;
        const rules = this.config.sampling?.rules || [];
        for (const rule of rules) {
            const opMatch = rule.operation && name.includes(rule.operation);
            const svcMatch =
                rule.service &&
                (this.config.serviceName ?? 'unknown-service') === rule.service;
            if (opMatch || svcMatch) {
                rate = rule.rate;
                break;
            }
        }

        const strategy = this.config.sampling?.strategy ?? 'probabilistic';
        const sampled =
            strategy === 'always'
                ? true
                : strategy === 'never'
                  ? false
                  : Math.random() < rate;
        if (!sampled) {
            return this.createNoOpSpan();
        }

        const finalAttributes: Record<string, string | number | boolean> = {
            serviceName: this.config.serviceName ?? 'unknown-service',
            ...this.config.globalAttributes,
            ...options.attributes,
        };

        // Auto-parent to current span when available and no parent provided
        const parentFromAls = this.als.getStore()?.getSpanContext();
        const parentContext =
            options.parent ||
            parentFromAls ||
            this.currentSpan?.getSpanContext();

        const span = this.tracer.startSpan(name, {
            ...options,
            parent: parentContext,
            attributes: finalAttributes,
        });

        this.currentSpan = span;

        return span;
    }

    /**
     * Execute a function within a span context
     * @param span The span to execute within
     * @param fn The function to execute
     * @param options Optional configuration including timeout
     */
    async withSpan<T>(
        span: Span,
        fn: () => T | Promise<T>,
        options?: { timeoutMs?: number },
    ): Promise<T> {
        const previousSpan = this.currentSpan;
        this.currentSpan = span;

        return await this.als.run(span, async () => {
            try {
                let result: T;

                // Apply timeout if specified
                if (options?.timeoutMs) {
                    result = await Promise.race<T>([
                        Promise.resolve(fn()),
                        new Promise<T>((_, reject) =>
                            setTimeout(() => {
                                const error = new Error(
                                    `Span execution timeout after ${options.timeoutMs}ms`,
                                );
                                error.name = 'SpanTimeoutError';
                                reject(error);
                            }, options.timeoutMs),
                        ),
                    ]);
                } else {
                    result = await fn();
                }

                span.setStatus({ code: 'ok' });
                return result;
            } catch (error) {
                span.recordException(error as Error);
                throw error;
            } finally {
                span.end();
                this.currentSpan = previousSpan;

                // Process the completed span (skip no-op spans)
                if (span.getSpanContext().traceId !== 'noop') {
                    const traceItem = span.toTraceItem();

                    // CRITICAL: For LLM spans (billing data), we MUST ensure they are saved
                    // For normal spans, we use fire-and-forget for performance
                    if (isCriticalSpan(traceItem)) {
                        // Synchronous processing for critical spans - blocks until saved
                        await this.processTraceItem(traceItem);
                    } else {
                        // Async fire-and-forget for normal spans - doesn't block
                        void this.processTraceItem(traceItem);
                    }
                }
            }
        });
    }

    /**
     * Get the current active span
     */
    getCurrentSpan(): Span | undefined {
        return this.als.getStore() || this.currentSpan;
    }

    /**
     * Add a trace processor
     */
    addTraceProcessor(processor: SpanProcessor): void {
        this.processors.push(processor);
    }

    /**
     * Remove a trace processor
     */
    removeTraceProcessor(processor: SpanProcessor): void {
        const index = this.processors.indexOf(processor);
        if (index > -1) {
            this.processors.splice(index, 1);
        }
    }

    /**
     * Process a trace item through all processors
     */
    private async processTraceItem(item: TraceItem): Promise<void> {
        const isCritical = isCriticalSpan(item);

        for (const processor of this.processors) {
            const maxRetries = isCritical ? 3 : 1; // Critical spans get 3 retries
            let lastError: Error | undefined;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    await processor.process(item);
                    lastError = undefined;
                    break; // Success, exit retry loop
                } catch (error) {
                    lastError = error as Error;

                    if (attempt < maxRetries) {
                        // Wait before retry (exponential backoff)
                        const backoffMs = Math.min(
                            100 * Math.pow(2, attempt - 1),
                            1000,
                        );
                        await new Promise((resolve) =>
                            setTimeout(resolve, backoffMs),
                        );
                    }
                }
            }

            // If all retries failed, log critical error
            if (lastError) {
                const errorLevel = isCritical ? 'error' : 'warn';
                this.logger[errorLevel]({
                    message: isCritical
                        ? '🚨 CRITICAL: LLM span processing failed after all retries - BILLING DATA MAY BE LOST'
                        : 'Trace processor failed',
                    context: this.constructor.name,
                    error: lastError,
                    metadata: {
                        processor: processor.constructor.name,
                        traceId: item.context.traceId,
                        spanId: item.context.spanId,
                        isCriticalSpan: isCritical,
                        isLLMSpan: isCritical,
                        totalTokens: item.attributes[GEN_AI.USAGE_TOTAL_TOKENS],
                        maxRetriesAttempted: maxRetries,
                    },
                });
            }
        }
    }

    /**
     * Flush all processors
     */
    async flush(): Promise<void> {
        for (const processor of this.processors) {
            try {
                if (processor.flush) {
                    await processor.flush();
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to flush processor',
                    context: this.constructor.name,
                    error: error as Error,

                    metadata: {
                        processor: processor.constructor.name,
                    },
                });
            }
        }
    }

    /**
     * Shutdown telemetry system and cleanup resources
     */
    async shutdown(): Promise<void> {
        this.logger.log({
            message: 'Shutting down telemetry system',
            context: this.constructor.name,
        });

        // Flush all pending data
        await this.flush();

        // Shutdown all processors
        for (const processor of this.processors) {
            try {
                if (processor.shutdown) {
                    await processor.shutdown();
                }
            } catch (error) {
                this.logger.error({
                    message: 'Failed to shutdown processor',
                    context: this.constructor.name,
                    error: error as Error,
                    metadata: {
                        processor: processor.constructor.name,
                    },
                });
            }
        }

        // Clear resources
        this.processors = [];
        this.currentSpan = undefined;

        this.logger.log({
            message: 'Telemetry system shutdown complete',
            context: this.constructor.name,
        });
    }

    /**
     * Get telemetry configuration
     */
    getConfig(): TelemetryConfig {
        return { ...this.config };
    }

    /**
     * Update telemetry configuration
     */
    updateConfig(config: Partial<TelemetryConfig>): void {
        this.config = { ...this.config, ...config };
    }

    /**
     * Get telemetry statistics
     */
    getStats(): {
        activeSpans: number;
        processors: number;
        enabled: boolean;
        samplingRate: number;
    } {
        return {
            activeSpans: this.tracer.getActiveSpanCount(),
            processors: this.processors.length,
            enabled: this.config.enabled,
            samplingRate: this.config.sampling?.rate ?? 1.0,
        };
    }

    /**
     * Create a no-op span for when telemetry is disabled
     */
    private createNoOpSpan(): Span {
        return {
            setAttribute: () => this.createNoOpSpan(),
            setAttributes: () => this.createNoOpSpan(),
            setStatus: () => this.createNoOpSpan(),
            recordException: () => this.createNoOpSpan(),
            addEvent: () => this.createNoOpSpan(),
            end: () => {},
            getSpanContext: () => ({
                traceId: 'noop',
                spanId: 'noop',
                traceFlags: 0,
            }),
            isRecording: () => false,
            getName: () => 'noop',
            getKind: () => 'internal',
            getDuration: () => undefined,
            getAttributes: () => ({}),
            getEvents: () => [],
            getStatus: () => ({ code: 'ok' }),
            toTraceItem: () => ({
                name: 'noop',
                context: { traceId: 'noop', spanId: 'noop', traceFlags: 0 },
                attributes: {},
                startTime: Date.now(),
                endTime: Date.now(),
                duration: 0,
                status: { code: 'ok' },
            }),
        };
    }
}
