// The one error a HostProvider throws (docs/runtime/host-providers.md §4.2):
// a closed kind the controller decides on, the provider's own code for logs,
// and the wait the provider asked for. An adapter maps every failure it knows
// to one of these; anything else is `transient`.

export const PROVIDER_ERROR_KINDS = ['throttled', 'quota_exceeded', 'capacity_unavailable', 'invalid_class', 'unauthorized', 'transient'] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** The start window a throttled create counts against (boat's starts-minute/hour/day). */
export type ThrottleWindow = 'minute' | 'hour' | 'day';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['throttled', 'capacity_unavailable', 'transient']);

export class ProviderError extends Error {
    readonly name = 'ProviderError';

    constructor(
        readonly kind: ProviderErrorKind,
        /** The provider's code (`rate_limited`, `no_ready_machine`, `http_503`): logged, never shown to a customer. */
        readonly code: string,
        readonly detail: { retryAfterMs?: number; window?: ThrottleWindow; status?: number } = {},
    ) {
        super(`${kind}: ${code}`);
    }

    /** Whether the same call, with the same client token, may be sent again after `retryAfterMs`. */
    get retryable(): boolean {
        return RETRYABLE.has(this.kind);
    }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;
