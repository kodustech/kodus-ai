import type { Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';

export type FailureKind =
    | 'timeout'
    | 'cancelled'
    | 'network'
    | 'permission_denied'
    | 'invalid_input'
    | 'unexpected';
const KINDS: ReadonlySet<string> = new Set([
    'timeout',
    'cancelled',
    'network',
    'permission_denied',
    'invalid_input',
    'unexpected',
]);

// Values are selected from code, never copied from exception text or arbitrary codes.
const CODES: Readonly<Record<string, FailureKind>> = Object.freeze({
    ETIMEDOUT: 'timeout',
    ECONNABORTED: 'timeout',
    ABORT_ERR: 'cancelled',
    ECONNRESET: 'network',
    ECONNREFUSED: 'network',
    ENOTFOUND: 'network',
    EAI_AGAIN: 'network',
    EPIPE: 'network',
    EACCES: 'permission_denied',
    EPERM: 'permission_denied',
    ERR_INVALID_ARG_TYPE: 'invalid_input',
});

/** Exception messages, stack traces, request objects and custom names can contain credentials. */
export function safeFailure(error: unknown): {
    kind: FailureKind;
    code?: string;
} {
    try {
        if (error && typeof error === 'object') {
            const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
            if (typeof code === 'string' && Object.hasOwn(CODES, code))
                return { kind: CODES[code], code };
            const name = Object.getOwnPropertyDescriptor(error, 'name')?.value;
            if (name === 'AbortError') return { kind: 'cancelled' };
            if (name === 'TimeoutError') return { kind: 'timeout' };
            const kind = Object.getOwnPropertyDescriptor(error, 'kind')?.value;
            if (
                typeof kind === 'string' &&
                KINDS.has(kind) &&
                Object.getOwnPropertyNames(error).every(
                    (key) => key === 'kind' || key === 'code',
                )
            )
                return { kind: kind as FailureKind };
            if (
                error instanceof TypeError ||
                error instanceof RangeError ||
                error instanceof SyntaxError
            )
                return { kind: 'invalid_input' };
        }
    } catch {
        /* A hostile accessor/proxy is not diagnostic data. */
    }
    return { kind: 'unexpected' };
}

/** Record one bounded failure classification while leaving the original exception with its caller. */
export function recordSafeFailure(span: Span, error: unknown): void {
    const failure = safeFailure(error);
    span.setAttribute('error.type', failure.kind);
    if (failure.code) span.setAttribute('runtime.error.code', failure.code);
    span.addEvent('exception', { 'exception.type': failure.kind });
    span.setStatus({ code: SpanStatusCode.ERROR });
}
