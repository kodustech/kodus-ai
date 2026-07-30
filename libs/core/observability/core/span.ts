import {
    SpanContext,
    SpanKind,
    SpanOptions,
    SpanStatus,
    TraceItem,
} from '../types';
import { SimpleTracer } from './tracer';

/**
 * Simple and robust span implementation
 */
export class Span {
    private context: SpanContext;
    private tracer: SimpleTracer;
    private name: string;
    private kind: SpanKind;
    private startTime: number;
    private endTime?: number;
    private attributes: Record<string, string | number | boolean> = {};
    private status: SpanStatus = { code: 'ok' };
    private events: Array<{
        name: string;
        timestamp: number;
        attributes?: Record<string, unknown>;
    }> = [];

    constructor(
        context: SpanContext,
        tracer: SimpleTracer,
        name: string,
        options: SpanOptions = {},
    ) {
        this.context = context;
        this.tracer = tracer;
        this.name = name;
        this.kind = options.kind || 'internal';
        this.startTime = options.startTime || Date.now();
        this.attributes = { ...options.attributes };
    }

    /**
     * Set a single attribute
     */
    setAttribute(key: string, value: string | number | boolean): Span {
        this.attributes[key] = value;
        return this;
    }

    /**
     * Set multiple attributes
     */
    setAttributes(attributes: Record<string, string | number | boolean>): Span {
        Object.assign(this.attributes, attributes);
        return this;
    }

    /**
     * Set span status
     */
    setStatus(status: SpanStatus): Span {
        this.status = status;
        return this;
    }

    /**
     * Record an exception
     */
    recordException(error: Error): Span {
        this.events.push({
            name: 'exception',
            timestamp: Date.now(),
            attributes: {
                exceptionType: error.name,
                exceptionMessage: error.message,
                exceptionStack: error.stack,
            },
        });
        this.setStatus({ code: 'error', message: error.message });
        return this;
    }

    /**
     * Add an event to the span
     */
    addEvent(name: string, attributes?: Record<string, unknown>): Span {
        this.events.push({
            name,
            timestamp: Date.now(),
            attributes,
        });
        return this;
    }

    /**
     * End the span
     */
    end(endTime?: number): void {
        if (this.endTime !== undefined) {
            return; // Already ended
        }

        this.endTime = endTime || Date.now();

        // Remove from active spans
        this.tracer.removeSpan(this.context.spanId);
    }

    /**
     * Get span context
     */
    getSpanContext(): SpanContext {
        return this.context;
    }

    /**
     * Check if span is still recording
     */
    isRecording(): boolean {
        return this.endTime === undefined;
    }

    /**
     * Get span name
     */
    getName(): string {
        return this.name;
    }

    /**
     * Get span kind
     */
    getKind(): SpanKind {
        return this.kind;
    }

    /**
     * Get span duration
     */
    getDuration(): number | undefined {
        return this.endTime ? this.endTime - this.startTime : undefined;
    }

    /**
     * Get span attributes
     */
    getAttributes(): Record<string, string | number | boolean> {
        return { ...this.attributes };
    }

    /**
     * Get span events
     */
    getEvents(): ReadonlyArray<{
        name: string;
        timestamp: number;
        attributes?: Record<string, unknown>;
    }> {
        return this.events;
    }

    /**
     * Get span status
     */
    getStatus(): SpanStatus {
        return this.status;
    }

    /**
     * Convert to TraceItem for export
     */
    toTraceItem(): TraceItem {
        return {
            name: this.name,
            context: this.context,
            attributes: this.attributes,
            startTime: this.startTime,
            endTime: this.endTime || Date.now(),
            duration: this.getDuration() || 0,
            status: this.status,
        };
    }
}
