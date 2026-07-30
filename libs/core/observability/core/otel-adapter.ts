/**
 * Adapter for OpenTelemetry API
 */
import {
    Tracer,
    Span,
    SpanOptions,
    Context,
    trace,
    context,
    propagation,
} from '@opentelemetry/api';

// Re-export types to be used by our system
export type { Tracer, Span, SpanOptions, Context };

/**
 * Interface for the OTel Adapter to decouple direct dependency
 */
export interface IOtelAdapter {
    isAvailable(): boolean;
    getTracer(name: string, version?: string): Tracer;
    getCurrentContext(): Context;
    inject(context: Context, carrier: unknown): void;
    extract(context: Context, carrier: unknown): Context;
    contextFromIds(
        traceId: string,
        spanId: string,
        traceFlags?: number,
    ): Context;
}

export class OtelAdapter implements IOtelAdapter {
    /**
     * Check if OpenTelemetry API is available and initialized
     * In a real scenario, we might check if a global provider is registered
     */
    isAvailable(): boolean {
        // basic check if trace API is functional (it always is, returning no-op if not configured)
        return !!trace;
    }

    getTracer(name: string, version?: string): Tracer {
        return trace.getTracer(name, version);
    }

    getCurrentContext(): Context {
        return context.active();
    }

    inject(ctx: Context, carrier: unknown): void {
        propagation.inject(ctx, carrier);
    }

    extract(_ctx: Context, carrier: unknown): Context {
        return propagation.extract(context.active(), carrier);
    }

    contextFromIds(
        traceId: string,
        spanId: string,
        traceFlags: number = 1,
    ): Context {
        return trace.setSpanContext(context.active(), {
            traceId,
            spanId,
            traceFlags,
            isRemote: false,
        });
    }
}
