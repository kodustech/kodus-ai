import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { GraphBaselineChangedError } from '@libs/code-review/domain/graph-job-attempt';

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
}

export function classifyGraphJobError(error: unknown): ErrorClassification {
    const seen = new Set<unknown>();
    while (error && typeof error === 'object' && !seen.has(error)) {
        seen.add(error);
        if (error instanceof GraphBaselineChangedError)
            return ErrorClassification.RETRYABLE;
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
        if (
            retryableCodes.has(fields.code) ||
            retryableNames.has(fields.name)
        ) {
            return ErrorClassification.RETRYABLE;
        }
        error = fields.cause;
    }
    return ErrorClassification.PERMANENT;
}
