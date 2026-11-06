export type WebhookSetupFailureKind = 'permission' | 'rate_limited' | 'error';

export interface WebhookSetupFailure {
    reason: string;
    kind: WebhookSetupFailureKind;
    retryAfterMs?: number;
}

/**
 * Outcome of making sure a set of repositories has the Kodus webhook.
 * `notAttempted` holds the repositories left untouched after the provider
 * rate-limited the run; they are pending work, not failures of their own.
 */
export interface WebhookSetupResult {
    configured: string[];
    failed: Record<string, WebhookSetupFailure>;
    notAttempted: string[];
    rateLimited?: { retryAfterMs?: number };
    /** The provider delivers events through an app-level hook (GitHub App). */
    managedByApp?: boolean;
}
