import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

/**
 * Thrown when a processor detects (via pre-check) or observes that the
 * GitHub App installation rate-limit is exhausted.
 *
 * Carries `resetAt` so RabbitMQErrorHandler can republish the message
 * with a delay aligned to the bucket reset rather than the default
 * exponential backoff that keeps retrying inside the same exhausted
 * window.
 *
 * The error is recognized by the consumer error handler via the
 * `errorClassification` property (duck-typed so subclasses and plain
 * objects from external libs both work) or `instanceof` check.
 */
export class RateLimitError extends Error {
    /**
     * Identifies this error as rate-limit-classified for the error
     * handler. Duck-typed property — read defensively.
     */
    readonly errorClassification = ErrorClassification.RATE_LIMITED;

    /**
     * Wall-clock time when the bucket is expected to reset. Comes from
     * the GitHub `x-ratelimit-reset` header (unix seconds) or from
     * `/rate_limit` `reset` field. If unknown (e.g. when triggered by a
     * pre-check that itself failed), pass `new Date()` to mean
     * "retry as soon as the handler decides".
     */
    readonly resetAt: Date;

    /**
     * `remaining` reported by GitHub at the moment of detection. Useful
     * for telemetry / debugging only; the handler does not use it.
     */
    readonly remaining?: number;

    /**
     * Optional context (org id, installation id) — kept on the error so
     * downstream logging / status-update sites have it without rebuilding
     * the context from headers.
     */
    readonly context?: {
        organizationId?: string;
        teamId?: string;
        installationId?: string | number;
    };

    constructor(params: {
        resetAt: Date;
        remaining?: number;
        message?: string;
        context?: RateLimitError['context'];
    }) {
        super(
            params.message ??
                `GitHub rate limit exhausted, retry at ${params.resetAt.toISOString()}`,
        );
        this.name = 'RateLimitError';
        this.resetAt = params.resetAt;
        this.remaining = params.remaining;
        this.context = params.context;
    }
}

/**
 * Type guard that recognizes both real instances and plain objects
 * carrying `errorClassification === RATE_LIMITED` + `resetAt`. The duck
 * type matters because errors can cross AMQP boundaries serialized,
 * or come from upstream code that doesn't import this exact class.
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
    if (error instanceof RateLimitError) return true;
    if (
        typeof error === 'object' &&
        error !== null &&
        (error as any).errorClassification ===
            ErrorClassification.RATE_LIMITED &&
        (error as any).resetAt instanceof Date
    ) {
        return true;
    }
    return false;
}
