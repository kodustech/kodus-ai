import { IdGenerator } from '@libs/core/utils/id-generator';
import { createLogger } from '@libs/core/log/logger';
import {
    SpanOptions,
    SpanContext,
    Tracer as TracerInterface,
    Span,
} from '../types';
import { Span as SimpleSpan } from './span';

/**
 * Simple and robust tracer implementation
 */
export class SimpleTracer implements TracerInterface {
    private activeSpans = new Map<string, Span>();
    private maxActiveSpans = 10000; // Prevent memory leaks
    private currentSpan?: Span;
    private logger = createLogger('tracer');

    /**
     * Start a new span
     */
    startSpan(name: string, options: SpanOptions = {}): Span {
        // Validate input
        if (!name || typeof name !== 'string') {
            throw new Error('Span name must be a non-empty string');
        }

        if (name.trim().length === 0) {
            throw new Error('Span name cannot be empty or whitespace');
        }

        // Check if we're approaching the limit
        if (this.activeSpans.size >= this.maxActiveSpans) {
            this.logger.warn({
                message: 'Too many active spans, creating no-op span',
                context: this.constructor.name,

                metadata: {
                    activeSpans: this.activeSpans.size,
                    maxActiveSpans: this.maxActiveSpans,
                },
            });
            return new SimpleSpan(
                this.createSpanContext(
                    IdGenerator.generateTraceId(),
                    IdGenerator.generateSpanId(),
                ),
                this,
                name,
                options,
            ) as Span;
        }

        const spanId = IdGenerator.generateSpanId();
        const traceId =
            options.parent?.traceId || IdGenerator.generateTraceId();

        const spanContext = this.createSpanContext(
            traceId,
            spanId,
            options.parent?.spanId,
        );
        const span = new SimpleSpan(spanContext, this, name, options) as Span;

        this.activeSpans.set(spanId, span);

        // Auto-cleanup after 1 hour to prevent memory leaks
        setTimeout(
            () => {
                if (this.activeSpans.has(spanId) && !span.isRecording()) {
                    this.activeSpans.delete(spanId);
                }
            },
            60 * 60 * 1000,
        );

        return span;
    }

    /**
     * Create a span context
     */
    createSpanContext(
        traceId: string,
        spanId: string,
        parentSpanId?: string,
    ): SpanContext {
        if (!traceId || typeof traceId !== 'string') {
            throw new Error('TraceId must be a non-empty string');
        }
        if (!spanId || typeof spanId !== 'string') {
            throw new Error('SpanId must be a non-empty string');
        }

        return {
            traceId,
            spanId,
            parentSpanId,
            traceFlags: 1, // Sampled
        };
    }

    /**
     * Get active span count for monitoring
     */
    getActiveSpanCount(): number {
        return this.activeSpans.size;
    }

    /**
     * Clean up completed spans
     */
    cleanupCompletedSpans(): void {
        Array.from(this.activeSpans.entries()).forEach(([spanId, span]) => {
            if (!span.isRecording()) {
                this.activeSpans.delete(spanId);
            }
        });
    }

    /**
     * Remove span from active tracking
     */
    removeSpan(spanId: string): void {
        this.activeSpans.delete(spanId);
    }

    /**
     * Get all active spans (for debugging)
     */
    getActiveSpans(): Span[] {
        return Array.from(this.activeSpans.values());
    }

    /**
     * Get the current span
     */
    getCurrentSpan(): Span | undefined {
        return this.currentSpan;
    }

    /**
     * Set the current span
     */
    setCurrentSpan(span: Span): void {
        this.currentSpan = span;
    }

    /**
     * Remove the current span
     */
    removeCurrentSpan(): void {
        this.currentSpan = undefined;
    }
}
