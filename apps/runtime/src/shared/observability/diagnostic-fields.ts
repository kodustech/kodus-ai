import { safeFailure } from '@libs/runtime/telemetry/failure';

const RESERVED = new Set([
    'at',
    'level',
    'service',
    'context',
    'msg',
    'traceId',
    'spanId',
]);
const SENSITIVE =
    /token|secret|password|authorization|cookie|certificate|private.?key|api.?key|prompt|stdout|stderr|stack|command|body|payload|headers/i;
const ERROR = /^(error|err|exception)$/i;
const MAX_STRING = 512;

/** Bounded JSON data only: no getters, toJSON, exception payloads or canonical overrides. */
export function diagnosticFields(fields: unknown): Record<string, unknown> {
    let remaining = 6000;
    let nodes = 128;
    const seen = new WeakSet<object>();
    const visit = (value: unknown, depth: number): unknown => {
        if (--nodes < 0 || remaining <= 0) return undefined;
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number')
            return Number.isFinite(value) ? value : undefined;
        if (typeof value === 'string') {
            const text = value.slice(
                0,
                Math.min(MAX_STRING, Math.floor(remaining / 4)),
            );
            remaining -= Buffer.byteLength(text);
            return text;
        }
        if (!value || typeof value !== 'object' || depth > 3 || seen.has(value))
            return undefined;
        seen.add(value);
        try {
            if (value instanceof Error) return safeFailure(value);
            const out: Record<string, unknown> = Object.create(null);
            for (const key of Object.getOwnPropertyNames(value).slice(0, 32)) {
                if (
                    key.length > 64 ||
                    key === 'toJSON' ||
                    (depth === 0 && RESERVED.has(key)) ||
                    SENSITIVE.test(key)
                )
                    continue;
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor?.enumerable || !('value' in descriptor))
                    continue;
                remaining -= Buffer.byteLength(key);
                const child = ERROR.test(key)
                    ? safeFailure(descriptor.value)
                    : visit(descriptor.value, depth + 1);
                if (child !== undefined) out[key] = child;
                if (remaining <= 0 || nodes <= 0) break;
            }
            return out;
        } catch {
            return undefined;
        }
    };
    return (visit(fields, 0) as Record<string, unknown>) ?? {};
}
