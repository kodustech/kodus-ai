export type ReviewModelCallFailureCategory =
    | 'provider_transport'
    | 'provider_rate_limit'
    | 'provider_timeout'
    | 'provider_authentication'
    | 'structured_output_parse'
    | 'structured_output_schema'
    | 'structured_output_conformance'
    | 'cancellation'
    | 'internal'
    | 'unknown';

const PARSE_ERROR_NAMES = new Set(['AI_JSONParseError', 'JSONParseError']);
const SCHEMA_ERROR_NAMES = new Set([
    'AI_TypeValidationError',
    'TypeValidationError',
]);
const STRUCTURED_OUTPUT_ERROR_NAMES = new Set([
    'AI_NoObjectGeneratedError',
    'NoObjectGeneratedError',
]);
const CANCELLATION_ERROR_NAMES = new Set([
    'AbortError',
    'CanceledError',
    'CancelledError',
]);
const CANCELLATION_ERROR_CODES = new Set(['ABORT_ERR', 'ERR_CANCELED']);
const TIMEOUT_ERROR_NAMES = new Set([
    'TimeoutError',
    'ConnectTimeoutError',
    'HeadersTimeoutError',
    'BodyTimeoutError',
]);
const TIMEOUT_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
const TRANSPORT_ERROR_CODES = new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
]);
const PROVIDER_ERROR_NAMES = new Set([
    'AI_APICallError',
    'APICallError',
    'AI_RetryError',
    'RetryError',
]);

interface ErrorFacts {
    readonly name?: string;
    readonly code?: string;
    readonly status?: number;
    readonly message?: string;
}

/**
 * Maps an uncontrolled model-call failure to a fixed telemetry value.
 * The returned value never includes provider text or fields from the input.
 */
export function categorizeReviewModelCallFailure(
    error: unknown,
): ReviewModelCallFailureCategory {
    const chain = errorChain(error);

    if (chain.some((entry) => PARSE_ERROR_NAMES.has(entry.name ?? ''))) {
        return 'structured_output_parse';
    }
    if (chain.some((entry) => SCHEMA_ERROR_NAMES.has(entry.name ?? ''))) {
        return 'structured_output_schema';
    }
    if (
        chain.some((entry) =>
            STRUCTURED_OUTPUT_ERROR_NAMES.has(entry.name ?? ''),
        )
    ) {
        return 'structured_output_conformance';
    }
    if (
        chain.some(
            (entry) =>
                CANCELLATION_ERROR_NAMES.has(entry.name ?? '') ||
                CANCELLATION_ERROR_CODES.has(entry.code ?? ''),
        )
    ) {
        return 'cancellation';
    }
    if (
        chain.some(
            (entry) =>
                TIMEOUT_ERROR_NAMES.has(entry.name ?? '') ||
                TIMEOUT_ERROR_CODES.has(entry.code ?? '') ||
                entry.message?.includes('[HARD-TIMEOUT]') === true,
        )
    ) {
        return 'provider_timeout';
    }
    if (chain.some((entry) => entry.status === 401 || entry.status === 403)) {
        return 'provider_authentication';
    }
    if (chain.some((entry) => entry.status === 429)) {
        return 'provider_rate_limit';
    }
    if (
        chain.some(
            (entry) =>
                TRANSPORT_ERROR_CODES.has(entry.code ?? '') ||
                (entry.status !== undefined &&
                    entry.status >= 500 &&
                    entry.status <= 599) ||
                PROVIDER_ERROR_NAMES.has(entry.name ?? ''),
        )
    ) {
        return 'provider_transport';
    }
    if (error instanceof Error) {
        return 'internal';
    }
    return 'unknown';
}

function errorChain(error: unknown): readonly ErrorFacts[] {
    const facts: ErrorFacts[] = [];
    const seen = new Set<object>();
    let current: unknown = error;

    for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
        if (seen.has(current)) {
            break;
        }
        seen.add(current);
        facts.push(readFacts(current));
        current = current.cause;
    }

    return facts;
}

function readFacts(value: Readonly<Record<string, unknown>>): ErrorFacts {
    const response = isRecord(value.response) ? value.response : undefined;
    const status = firstNumber(
        value.status,
        value.statusCode,
        response?.status,
    );
    return {
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(typeof value.code === 'string' ? { code: value.code } : {}),
        ...(status === undefined ? {} : { status }),
        ...(typeof value.message === 'string'
            ? { message: value.message }
            : {}),
    };
}

function firstNumber(...values: readonly unknown[]): number | undefined {
    return values.find(
        (value): value is number =>
            typeof value === 'number' && Number.isSafeInteger(value),
    );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
