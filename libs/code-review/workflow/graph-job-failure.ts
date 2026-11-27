import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import {
    GraphBaselineChangedError,
    GraphCheckoutRecoveryError,
    GraphWorkerShutdownError,
} from '@libs/code-review/domain/graph-job-attempt';

const retryableCodes = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ENOMEM',
    'ENOSPC',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
]);
const retryableNames = new Set([
    'TimeoutError',
    'WorkflowJobTimeoutError',
    'NotEnoughSpaceError',
    'SandboxNotFoundError',
    'SandboxWaitAbortedError',
    'SandboxInvalidatedError',
    'RateLimitError',
    'SandboxCreateTimeoutError',
    'SandboxCircuitOpenError',
    'SandboxStaleConnectionError',
]);

interface GraphErrorFields {
    code?: string;
    name?: string;
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number };
    cause?: unknown;
    lastError?: unknown;
    errors?: unknown;
    sandboxSetup?: { operation?: string; exitCode?: number };
}

export function classifyGraphJobError(error: unknown): ErrorClassification {
    const seen = new Set<unknown>();
    let retryable = false;
    const pending: unknown[] = [error];
    while (pending.length) {
        const error = pending.pop();
        if (!error || typeof error !== 'object' || seen.has(error)) continue;
        seen.add(error);
        const fields = error as GraphErrorFields;
        const status = [
            fields.status,
            fields.statusCode,
            fields.response?.status,
            fields.response?.statusCode,
        ].find(
            (value) => typeof value === 'number' && value >= 400 && value < 600,
        );
        if (status !== undefined) {
            return status === 408 || status === 429 || status >= 500
                ? ErrorClassification.RETRYABLE
                : ErrorClassification.PERMANENT;
        }
        // A retry wrapper's other entries describe previous attempts.
        const lastError = fields.lastError;
        if (
            lastError &&
            typeof lastError === 'object' &&
            !seen.has(lastError)
        ) {
            pending.push(lastError);
            continue;
        }
        const setup = fields.sandboxSetup;
        if (
            error instanceof GraphBaselineChangedError ||
            error instanceof GraphWorkerShutdownError ||
            error instanceof GraphCheckoutRecoveryError ||
            retryableCodes.has(fields.code) ||
            retryableNames.has(fields.name) ||
            ((setup?.operation === 'git-fetch' ||
                setup?.operation === 'graph-install') &&
                typeof setup.exitCode === 'number' &&
                setup.exitCode !== 0 &&
                setup.exitCode !== 126 &&
                setup.exitCode !== 127)
        ) {
            retryable = true;
        }
        if (Array.isArray(fields.errors)) {
            for (let i = fields.errors.length - 1; i >= 0; i--)
                pending.push(fields.errors[i]);
        }
        pending.push(fields.cause);
    }
    return retryable
        ? ErrorClassification.RETRYABLE
        : ErrorClassification.PERMANENT;
}
