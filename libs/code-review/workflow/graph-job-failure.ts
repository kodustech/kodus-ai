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
// statement_timeout, lock_timeout, serialization, deadlock, too many
// connections, and the three shutdown states. Class 08 is connection loss.
const retryableSqlStates = new Set([
    '57014',
    '55P03',
    '40001',
    '40P01',
    '53300',
    '57P01',
    '57P02',
    '57P03',
]);

interface GraphErrorFields {
    code?: string;
    name?: string;
    message?: string;
    status?: number;
    statusCode?: number;
    response?: { status?: number; statusCode?: number };
    cause?: unknown;
    lastError?: unknown;
    errors?: unknown;
    driverError?: { code?: string };
    sandboxSetup?: { operation?: string; exitCode?: number };
}

function sqlState(code: unknown): string | undefined {
    return typeof code === 'string' && /^[0-9][0-9A-Z]{4}$/.test(code)
        ? code
        : undefined;
}

function isRetryableSqlState(code: string): boolean {
    return retryableSqlStates.has(code) || code.startsWith('08');
}

// apiErrorFromCode stores the HTTP status as `${status}: ${content}` and
// sets no status field. Only that prefix counts. A later "503:" is quoted text.
function sandboxApiStatus(error: GraphErrorFields): number | undefined {
    if (error.name !== 'SandboxError' || typeof error.message !== 'string') {
        return undefined;
    }
    if (error.message.indexOf(': ') !== 3) return undefined;
    const status = Number(error.message.slice(0, 3));
    if (!Number.isInteger(status) || status < 500 || status > 599) {
        return undefined;
    }
    return status;
}

// pg-pool uses these two sentences as the whole error message. A parser
// message that quotes one of them is a different, permanent failure.
const transientMessages = new Set([
    'timeout exceeded when trying to connect',
    'connection terminated due to connection timeout',
    'temporarily unavailable',
    'service temporarily unavailable',
    'provider temporarily unavailable',
]);

function transientMessage(message: string): boolean {
    return transientMessages.has(
        message.trim().toLowerCase().replace(/\.$/, ''),
    );
}

export function classifyGraphJobError(error: unknown): ErrorClassification {
    const seen = new Set<unknown>();
    const messages: string[] = [];
    let retryable = false;
    // A SQLSTATE or a sandbox exit we understood, even when it is permanent.
    // The message fallback must not override that decision.
    let structured = false;
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
        const sandboxStatus = sandboxApiStatus(fields);
        // 500 is a failed sandbox create. Other 5xx responses are transient.
        // Keep walking: an HTTP status or another attempt can still decide.
        if (sandboxStatus === 500) structured = true;
        else if (sandboxStatus !== undefined) retryable = true;
        const state =
            sqlState(fields.code) ?? sqlState(fields.driverError?.code);
        if (state) {
            if (isRetryableSqlState(state)) retryable = true;
            else structured = true;
        }
        const setup = fields.sandboxSetup;
        const setupExit =
            (setup?.operation === 'git-fetch' ||
                setup?.operation === 'graph-install') &&
            typeof setup.exitCode === 'number'
                ? setup.exitCode
                : undefined;
        if (
            error instanceof GraphBaselineChangedError ||
            error instanceof GraphWorkerShutdownError ||
            error instanceof GraphCheckoutRecoveryError ||
            retryableCodes.has(fields.code) ||
            retryableNames.has(fields.name) ||
            (setupExit !== undefined &&
                setupExit !== 0 &&
                setupExit !== 126 &&
                setupExit !== 127)
        ) {
            retryable = true;
        } else if (setupExit === 0 || setupExit === 126 || setupExit === 127) {
            structured = true;
        }
        if (typeof fields.message === 'string') messages.push(fields.message);
        if (Array.isArray(fields.errors)) {
            for (let i = fields.errors.length - 1; i >= 0; i--)
                pending.push(fields.errors[i]);
        }
        pending.push(fields.cause);
    }
    if (retryable) return ErrorClassification.RETRYABLE;
    // pg-pool acquire and connect timeouts have no code and no status.
    if (!structured && messages.some(transientMessage)) {
        return ErrorClassification.RETRYABLE;
    }
    return ErrorClassification.PERMANENT;
}
