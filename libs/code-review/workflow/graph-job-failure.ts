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
    sandboxSetup?: { operation?: string; exitCode?: number };
}

export function classifyGraphJobError(error: unknown): ErrorClassification {
    const seen = new Set<unknown>();
    let retryable = false;
    while (error && typeof error === 'object' && !seen.has(error)) {
        seen.add(error);
        if (
            error instanceof GraphBaselineChangedError ||
            error instanceof GraphWorkerShutdownError ||
            error instanceof GraphCheckoutRecoveryError
        )
            retryable = true;
        const fields = error as GraphErrorFields;
        const status =
            fields.status ??
            fields.statusCode ??
            fields.response?.status ??
            fields.response?.statusCode;
        if (typeof status === 'number' && status >= 400 && status < 600) {
            return status === 408 || status === 429 || status >= 500
                ? ErrorClassification.RETRYABLE
                : ErrorClassification.PERMANENT;
        }
        const setup = fields.sandboxSetup;
        if (
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
        error = fields.cause;
    }
    return retryable
        ? ErrorClassification.RETRYABLE
        : ErrorClassification.PERMANENT;
}
