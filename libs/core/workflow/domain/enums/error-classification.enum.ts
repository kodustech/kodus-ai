export enum ErrorClassification {
    RETRYABLE = 'RETRYABLE',
    NON_RETRYABLE = 'NON_RETRYABLE',
    CIRCUIT_OPEN = 'CIRCUIT_OPEN',
    PERMANENT = 'PERMANENT',
    /**
     * Job hit the GitHub App installation rate-limit (primary or
     * secondary). The RabbitMQErrorHandler honors this by waiting until
     * the bucket resets (plus a 5-min safety buffer, capped at 1h)
     * instead of using the linear/exponential backoff used for transient
     * RETRYABLE errors. Companion type: RateLimitError (carries `resetAt`).
     */
    RATE_LIMITED = 'RATE_LIMITED',
}
