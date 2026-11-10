import {
    type Attributes,
    context,
    type Context,
    propagation,
    type Span,
    SpanStatusCode,
    trace,
} from '@opentelemetry/api';
import { recordSafeFailure } from '@libs/runtime/telemetry/failure';

// Spans of the Runtime processes. The worker injects W3C traceparent on every
// hub call (traceHeaders in libs/runtime/telemetry); the hub extracts it, so
// a claim acquire or a probe is one trace from the Run down to the cell.

const tracer = () => trace.getTracer('kody-runtime');

/** The parent context a request carries in its W3C headers. */
export function contextFromHeaders(
    headers: Record<string, string | string[] | undefined>,
): Context {
    return propagation.extract(context.active(), headers);
}

export interface SpanCompletion<T> {
    parent?: Context;
    /** Resolved typed failures are errors too; callers own their result contract. */
    statusOf?: (result: T) => SpanStatusCode;
}

export async function inSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
    completion: SpanCompletion<T> = {},
): Promise<T> {
    return tracer().startActiveSpan(
        name,
        { attributes },
        completion.parent ?? context.active(),
        async (span) => {
            try {
                const out = await fn(span);
                span.setStatus({
                    code: completion.statusOf?.(out) ?? SpanStatusCode.OK,
                });
                return out;
            } catch (error) {
                recordSafeFailure(span, error);
                throw error;
            } finally {
                span.end();
            }
        },
    );
}
