import { ProviderError, type ProviderErrorKind, type ThrottleWindow } from '@libs/runtime/fleet/provider-error';

// boat's errors as ProviderError (docs.boat.dev/limits and the API reference,
// read 2026-11-17). boat answers an ErrorEnvelope { ok, code, message,
// error: { code, message, status, details } }; the 429 body of rate_limited
// carries window, limit, cause, nextStartAt and retryAfterSeconds (read here
// from the top level or error.details). Only the code, the status and the wait
// leave this file: never boat's message, which can echo the request.

const WINDOWS: ReadonlySet<string> = new Set(['minute', 'hour', 'day']);

const BY_CODE: Record<string, ProviderErrorKind> = {
    rate_limited: 'throttled',
    IP_RATE_LIMIT_EXCEEDED: 'throttled',
    limit_reached: 'quota_exceeded',
    member_limit_reached: 'quota_exceeded',
    trial_compute_limit_reached: 'quota_exceeded',
    no_ready_machine: 'capacity_unavailable',
    out_of_capacity: 'capacity_unavailable',
    machine_class_plan_required: 'invalid_class',
    trial_machine_class_not_allowed: 'invalid_class',
    trial_auto_stop_required: 'invalid_class',
    idempotency_key_reused: 'invalid_class',
    idempotency_in_progress: 'transient',
};

/** The waits boat documents when a body names none (no_ready_machine 5 s, out_of_capacity 120 s). */
const DEFAULT_WAIT_MS: Record<string, number> = { no_ready_machine: 5_000, out_of_capacity: 120_000, idempotency_in_progress: 2_000 };

export function mapBoatError(status: number, body: unknown, headers: Headers): ProviderError {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
    const details = (b.error && typeof b.error === 'object' && b.error.details && typeof b.error.details === 'object' ? b.error.details : {}) as Record<string, any>;
    const field = (k: string) => b[k] ?? details[k];
    const rawCode = typeof b.code === 'string' ? b.code : typeof b.error?.code === 'string' ? b.error.code : `http_${status}`;
    const code = /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : `http_${status}`;
    const kind: ProviderErrorKind =
        BY_CODE[code] ??
        (status === 401 || status === 402 || status === 403 ? 'unauthorized' : status === 400 || status === 422 ? 'invalid_class' : status === 429 ? 'throttled' : status === 503 ? 'capacity_unavailable' : 'transient');
    const seconds = Number(field('retryAfterSeconds') ?? field('retryAfter') ?? headers.get('retry-after') ?? NaN);
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : DEFAULT_WAIT_MS[code];
    const window = typeof field('window') === 'string' && WINDOWS.has(field('window')) ? (field('window') as ThrottleWindow) : undefined;
    return new ProviderError(kind, code, { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(window ? { window } : {}), status });
}

/** A request that never got an answer (DNS, TLS, reset, timeout): sent again with the same Idempotency-Key. */
export const transportError = (e: unknown) => new ProviderError('transient', e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network');
