/**
 * The two ways an SDK call fails.
 *
 * - Infra: the runtime itself (spawn, crash, no result, gateway, pool queue).
 *   Before the first step, the same `exec` falls back to `generateText` (A6).
 * - API: the provider answered with an error. Built as the AI SDK's own
 *   `APICallError` from what the gateway recorded, so `classifyLLMError`, the
 *   BYOK banner and the failover cascade read it exactly as they read today's.
 */
import { APICallError } from '@ai-sdk/provider';

import type { UpstreamError } from './gateway/ledger';

export type ClaudeSdkInfraReason = 'spawn' | 'crash' | 'no-result' | 'gateway' | 'queue-timeout' | 'model-rejected' | 'aborted' | 'unlicensed';

export class ClaudeSdkInfraError extends Error {
    readonly reason: ClaudeSdkInfraReason;
    /** True when standing down is the intended outcome (no license): the core falls back without a warning. */
    readonly expected: boolean;

    constructor(reason: ClaudeSdkInfraReason, message: string, options?: { cause?: unknown }) {
        super(`[claude-sdk:${reason}] ${message}`, options);
        this.name = 'ClaudeSdkInfraError';
        this.reason = reason;
        this.expected = reason === 'unlicensed';
    }
}

export function isClaudeSdkInfraError(err: unknown): err is ClaudeSdkInfraError {
    return err instanceof ClaudeSdkInfraError;
}

/** The attempt's error from the last upstream error the gateway recorded. */
export function apiErrorFromUpstream(error: UpstreamError, url: string): APICallError {
    return new APICallError({
        message: providerMessage(error.body) ?? `upstream answered ${error.status}`,
        url,
        requestBodyValues: {},
        statusCode: error.status,
        responseHeaders: error.retryAfter ? { 'retry-after': error.retryAfter } : {},
        responseBody: error.body,
        isRetryable: error.status === 429 || error.status >= 500,
    });
}

function providerMessage(body: string): string | undefined {
    try {
        const parsed = JSON.parse(body);
        const message = parsed?.error?.message ?? parsed?.message;
        return typeof message === 'string' && message ? message : undefined;
    } catch {
        return undefined;
    }
}
