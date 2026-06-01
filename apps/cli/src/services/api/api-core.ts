import os from 'node:os';
import { Agent, fetch as undiciFetch } from 'undici';
import { ApiError } from '../../types/errors.js';
import { CLI_VERSION } from '../../constants.js';
import { loadConfig, type CliConfig } from '../../utils/config.js';
import { getDeviceIdentity, updateDeviceToken } from '../../utils/device.js';
import { cliDebug, cliError, isCliVerboseMode } from '../../utils/logger.js';

/**
 * Build the User-Agent string the CLI sends on every request. Includes the
 * CLI version, runtime (node) version, and OS — enough to power the auth
 * confirmation page ("Device: ...") and server-side dashboards without
 * leaking anything sensitive.
 */
function cliUserAgent(): string {
    const platform = `${os.platform()}/${os.release()}`;
    const node = process.version.replace(/^v/, '');
    return `KodusCLI/${CLI_VERSION} (${platform}; node ${node})`;
}

/**
 * Cached config loaded once at first request.
 */
let configCache: CliConfig | null | undefined;

async function getCachedConfig(): Promise<CliConfig | null> {
    if (configCache === undefined) {
        configCache = await loadConfig();
    }
    return configCache;
}

/** @internal Exported for testing only. */
export function resetApiConfigCache(): void {
    configCache = undefined;
}

/**
 * Validates a custom API URL. Returns it if valid, or null if invalid.
 */
function validateApiUrl(customUrl: string): string | null {
    const defaultUrl = 'https://api.kodus.io';

    try {
        const url = new URL(customUrl);

        const isLocalhost =
            url.hostname === 'localhost' || url.hostname === '127.0.0.1';
        if (url.protocol !== 'https:' && !isLocalhost) {
            cliError('Security Error: API URL must use HTTPS protocol');
            cliError(`Falling back to default: ${defaultUrl}`);
            return null;
        }

        const standardDomains = ['api.kodus.io', 'localhost', '127.0.0.1'];
        const isStandard = standardDomains.some(
            (domain) =>
                url.hostname === domain || url.hostname.endsWith(`.${domain}`),
        );

        if (!isStandard && isCliVerboseMode()) {
            cliDebug(`Warning: Using non-standard API URL: ${url.hostname}`);
        }

        return customUrl;
    } catch {
        cliError('Invalid API URL format:', customUrl);
        cliError(`Falling back to default: ${defaultUrl}`);
        return null;
    }
}

/**
 * Returns the API base URL.
 * Priority: KODUS_API_URL env var > config.json apiUrl > default
 */
export async function resolveApiBaseUrl(): Promise<string> {
    const defaultUrl = 'https://api.kodus.io';

    if (process.env.KODUS_API_URL) {
        return validateApiUrl(process.env.KODUS_API_URL) ?? defaultUrl;
    }

    const config = await getCachedConfig();
    if (config?.apiUrl) {
        return validateApiUrl(config.apiUrl) ?? defaultUrl;
    }

    return defaultUrl;
}

// Default 60 minutes — covers large branch reviews that split into many
// agent batches (e.g. ~6 batches × 5 min each). Overridable via
// KODUS_REQUEST_TIMEOUT_MIN (in minutes) for extreme cases.
const DEFAULT_REQUEST_TIMEOUT_MIN = 60;
const parsedTimeoutMin = Number.parseInt(
    process.env.KODUS_REQUEST_TIMEOUT_MIN ?? '',
    10,
);
const REQUEST_TIMEOUT_MIN =
    Number.isFinite(parsedTimeoutMin) && parsedTimeoutMin > 0
        ? parsedTimeoutMin
        : DEFAULT_REQUEST_TIMEOUT_MIN;
const REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MIN * 60 * 1000;

// Undici (the HTTP client used by Node's global fetch) defaults both
// headersTimeout and bodyTimeout to 5 minutes. Long CLI reviews of large
// branches easily exceed that, the client silently aborts, and the retry
// wrapper fires a new request — causing a retry storm where the backend
// processes the same review multiple times in parallel.
//
// We use undici's own fetch (imported from the installed undici package)
// with a dispatcher whose timeouts match REQUEST_TIMEOUT_MS. Passing a
// dispatcher to Node's global fetch does NOT work reliably: Node's bundled
// undici is a different module instance than the one installed here, so
// the Agent we create is not honored by the global fetch.
const longLivedDispatcher = new Agent({
    headersTimeout: REQUEST_TIMEOUT_MS,
    bodyTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: REQUEST_TIMEOUT_MS,
    keepAliveMaxTimeout: REQUEST_TIMEOUT_MS,
});

/**
 * Tear down the keep-alive HTTP pool used by every CLI request. Without
 * this, the dispatcher's idle sockets keep the Node event loop alive for
 * up to `REQUEST_TIMEOUT_MS` (60 min by default), so commands like
 * `kodus auth login` appear to "hang" after success — the user gets
 * dropped into raw stdin (still owned by the inquirer prompt that just
 * ran) and the shell never returns. Terminal commands should call this
 * once they've finished all API work.
 */
export async function closeApiClient(): Promise<void> {
    try {
        await longLivedDispatcher.close();
    } catch {
        // Best effort — never block shutdown on a dispatcher that's
        // already closing.
    }
}

/**
 * Returns Cloudflare Access headers when configured.
 * Priority: env vars > config.json
 */
export async function getCloudflareAccessHeaders(): Promise<
    Record<string, string>
> {
    const clientId = process.env.CF_ACCESS_CLIENT_ID;
    const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

    if (clientId && clientSecret) {
        return {
            'CF-Access-Client-Id': clientId,
            'CF-Access-Client-Secret': clientSecret,
        };
    }

    const config = await getCachedConfig();
    if (config?.cfAccessClientId && config?.cfAccessClientSecret) {
        return {
            'CF-Access-Client-Id': config.cfAccessClientId,
            'CF-Access-Client-Secret': config.cfAccessClientSecret,
        };
    }

    return {};
}

interface ApiErrorPayload {
    message?: string;
    code?: string;
    details?: {
        limit?: number;
        current?: number;
        activeDevices?: number;
    };
}

function getDefaultApiErrorMessage(
    statusCode: number,
    endpoint: string,
): string {
    const endpointPath = endpoint.split('?')[0] || endpoint;

    if (statusCode === 400) {
        return `Invalid request sent to Kodus API (${endpointPath}).`;
    }

    if (statusCode === 401) {
        if (endpointPath.startsWith('/cli/config/repositories')) {
            return 'Repository configuration requires team-key auth. Run: kodus auth team-key --key <your-key>.';
        }
        if (endpointPath === '/pull-requests/suggestions') {
            return 'Authentication failed while fetching pull request suggestions. Run: kodus auth login or configure a valid team key.';
        }
        return 'Authentication failed. Run: kodus auth login or configure a valid team key.';
    }

    if (statusCode === 403) {
        return `Access denied for Kodus API endpoint (${endpointPath}).`;
    }

    if (statusCode === 404) {
        return `Kodus API endpoint not found (${endpointPath}).`;
    }

    if (statusCode === 422) {
        return `Kodus API could not process the request (${endpointPath}).`;
    }

    if (statusCode === 429) {
        return 'Rate limit exceeded. Please try again later.';
    }

    if (statusCode >= 500) {
        return 'Kodus API is currently unavailable. Please try again.';
    }

    return `Request failed with status ${statusCode}`;
}

function normalizeApiErrorMessage(
    statusCode: number,
    endpoint: string,
    errorData: ApiErrorPayload,
): string {
    if (errorData.code === 'DEVICE_LIMIT_REACHED') {
        const limit = errorData.details?.limit;
        const activeDevices =
            errorData.details?.current ?? errorData.details?.activeDevices;
        if (typeof limit === 'number' && typeof activeDevices === 'number') {
            return `Device limit reached (${activeDevices}/${limit}). Remove an old device or contact your admin.`;
        }
        return 'Device limit reached for this organization. Remove an old device or contact your admin.';
    }

    const fallbackMessage = getDefaultApiErrorMessage(statusCode, endpoint);
    if (!errorData.message || typeof errorData.message !== 'string') {
        return fallbackMessage;
    }

    const endpointPath = endpoint.split('?')[0] || endpoint;
    const trimmed = errorData.message.trim();
    const hasNonAscii = /[^\p{ASCII}]/u.test(trimmed);

    if (
        statusCode === 404 &&
        endpointPath.startsWith('/cli/config/repositories/') &&
        endpointPath.endsWith('/settings') &&
        trimmed === `Cannot GET ${endpointPath}`
    ) {
        return 'Repository settings are not available in this Kodus API environment. `config remote show`, `setup`, and `set` require the repository settings endpoint.';
    }

    if (
        statusCode === 403 &&
        endpointPath.startsWith('/cli/config/repositories')
    ) {
        if (!trimmed || hasNonAscii) {
            return fallbackMessage;
        }

        return `Repository configuration access denied: ${trimmed}`;
    }

    if (statusCode === 401 || statusCode === 429 || statusCode >= 500) {
        return fallbackMessage;
    }

    if (statusCode === 403) {
        return trimmed && !hasNonAscii ? trimmed : fallbackMessage;
    }

    return trimmed;
}

export async function request<T>(
    endpoint: string,
    options: RequestInit = {},
): Promise<T> {
    const baseUrl = await resolveApiBaseUrl();
    const url = `${baseUrl}${endpoint}`;
    let deviceIdentity: { deviceId: string; deviceToken?: string } | undefined;

    if (isCliVerboseMode()) {
        cliDebug(`[API] ${options.method || 'GET'} ${url}`);
    }

    try {
        deviceIdentity = await getDeviceIdentity();
    } catch (error) {
        if (isCliVerboseMode()) {
            cliDebug('[API] Unable to resolve device id:', error);
        }
    }

    const cfHeaders = await getCloudflareAccessHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        const undiciOptions: any = {
            ...options,
            signal: controller.signal,
            dispatcher: longLivedDispatcher,
            headers: {
                'Content-Type': 'application/json',
                // Identify the CLI explicitly. Without this header, fetch in
                // Node ≥18 sends the default `undici/<v>` UA, which leaks
                // through to the auth-confirmation page as a meaningless
                // "Device: undici". Format mirrors the npm convention so
                // backend logs/dashboards stay greppable per CLI version.
                'User-Agent': cliUserAgent(),
                ...cfHeaders,
                ...(deviceIdentity?.deviceId
                    ? { 'X-Kodus-Device-Id': deviceIdentity.deviceId }
                    : {}),
                ...(deviceIdentity?.deviceToken
                    ? { 'X-Kodus-Device-Token': deviceIdentity.deviceToken }
                    : {}),
                ...options.headers,
            },
        };
        response = (await undiciFetch(
            url,
            undiciOptions,
        )) as unknown as Response;
    } catch (error) {
        clearTimeout(timeout);
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ApiError(
                408,
                'Request timed out. The server took too long to respond. Please try again.',
            );
        }
        throw error;
    }

    clearTimeout(timeout);

    const responseDeviceToken = response.headers.get('x-kodus-device-token');
    if (responseDeviceToken) {
        await updateDeviceToken(responseDeviceToken).catch(() => {});
    }

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');

    if (!response.ok) {
        const rawError = isJson
            ? await response.json().catch(() => ({ message: 'Request failed' }))
            : { message: `Request failed with status ${response.status}` };
        const errorData: ApiErrorPayload =
            rawError &&
            typeof rawError === 'object' &&
            'data' in rawError &&
            rawError.data &&
            typeof rawError.data === 'object' &&
            !('message' in rawError) &&
            !('code' in rawError)
                ? (rawError.data as ApiErrorPayload)
                : (rawError as ApiErrorPayload);
        const errorMessage = normalizeApiErrorMessage(
            response.status,
            endpoint,
            errorData,
        );

        if (isCliVerboseMode()) {
            cliDebug('[API] Error:', {
                status: response.status,
                url,
                contentType,
                errorData,
                normalizedMessage: errorMessage,
            });
        }

        throw new ApiError(response.status, errorMessage);
    }

    if (!isJson) {
        const text = await response.text();
        const preview = text.substring(0, 100);
        cliError(
            `[API] Expected JSON but received ${contentType || 'unknown content-type'}`,
        );
        cliError(`[API] URL: ${url}`);
        cliError(`[API] Response preview: ${preview}...`);
        throw new ApiError(
            500,
            `API returned invalid response (expected JSON, got ${contentType || 'HTML'})`,
        );
    }

    const json = (await response.json()) as any;

    if (isCliVerboseMode()) {
        cliDebug('[API] Raw response structure:', Object.keys(json));
        if (json && typeof json === 'object') {
            const preview: Record<string, unknown> = {};
            for (const key of Object.keys(json)) {
                const val = json[key];
                if (typeof val === 'string' && val.length > 100) {
                    preview[key] = `[string: ${val.length} chars]`;
                } else if (Array.isArray(val)) {
                    preview[key] = `[array: ${val.length} items]`;
                } else if (typeof val === 'object' && val !== null) {
                    preview[key] = `[object: ${Object.keys(val).join(', ')}]`;
                } else {
                    preview[key] = val;
                }
            }
            cliDebug(
                '[API] Response preview:',
                JSON.stringify(preview, null, 2),
            );
        }
    }

    if (json && typeof json === 'object' && 'data' in json) {
        return json.data as T;
    }

    return json as T;
}

export async function requestBinary(
    endpoint: string,
    options: RequestInit = {},
): Promise<Uint8Array> {
    const baseUrl = await resolveApiBaseUrl();
    const url = `${baseUrl}${endpoint}`;
    let deviceIdentity: { deviceId: string; deviceToken?: string } | undefined;

    if (isCliVerboseMode()) {
        cliDebug(`[API] ${options.method || 'GET'} ${url} (binary)`);
    }

    try {
        deviceIdentity = await getDeviceIdentity();
    } catch (error) {
        if (isCliVerboseMode()) {
            cliDebug('[API] Unable to resolve device id:', error);
        }
    }

    const cfHeaders = await getCloudflareAccessHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
        const undiciOptions: any = {
            ...options,
            signal: controller.signal,
            dispatcher: longLivedDispatcher,
            headers: {
                ...cfHeaders,
                ...(deviceIdentity?.deviceId
                    ? { 'X-Kodus-Device-Id': deviceIdentity.deviceId }
                    : {}),
                ...(deviceIdentity?.deviceToken
                    ? { 'X-Kodus-Device-Token': deviceIdentity.deviceToken }
                    : {}),
                ...options.headers,
            },
        };
        response = (await undiciFetch(
            url,
            undiciOptions,
        )) as unknown as Response;
    } catch (error) {
        clearTimeout(timeout);
        if (error instanceof DOMException && error.name === 'AbortError') {
            throw new ApiError(
                408,
                'Request timed out. The server took too long to respond. Please try again.',
            );
        }
        throw error;
    }

    clearTimeout(timeout);

    const responseDeviceToken = response.headers.get('x-kodus-device-token');
    if (responseDeviceToken) {
        await updateDeviceToken(responseDeviceToken).catch(() => {});
    }

    if (!response.ok) {
        const contentType = response.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');
        const rawError = isJson
            ? await response.json().catch(() => ({ message: 'Request failed' }))
            : { message: `Request failed with status ${response.status}` };
        const errorData: ApiErrorPayload =
            rawError &&
            typeof rawError === 'object' &&
            'data' in rawError &&
            rawError.data &&
            typeof rawError.data === 'object' &&
            !('message' in rawError) &&
            !('code' in rawError)
                ? (rawError.data as ApiErrorPayload)
                : (rawError as ApiErrorPayload);

        const errorMessage = normalizeApiErrorMessage(
            response.status,
            endpoint,
            errorData,
        );

        throw new ApiError(response.status, errorMessage);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
}

const RETRY_BACKOFF_MS = [1000, 3000];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

export async function requestWithRetry<T>(
    endpoint: string,
    options: RequestInit = {},
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        try {
            return await request<T>(endpoint, options);
        } catch (error) {
            lastError = error;

            const isLastAttempt = attempt >= RETRY_BACKOFF_MS.length;
            if (isLastAttempt) {
                break;
            }

            const isRetryable =
                (error instanceof ApiError &&
                    RETRYABLE_STATUS_CODES.has(error.statusCode)) ||
                (!(error instanceof ApiError) && error instanceof Error);

            if (!isRetryable) {
                break;
            }

            if (isCliVerboseMode()) {
                cliDebug(
                    `[API] Retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${RETRY_BACKOFF_MS[attempt]}ms`,
                );
            }

            await new Promise((resolve) =>
                setTimeout(resolve, RETRY_BACKOFF_MS[attempt]),
            );
        }
    }

    throw lastError;
}

export async function requestBinaryWithRetry(
    endpoint: string,
    options: RequestInit = {},
): Promise<Uint8Array> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
        try {
            return await requestBinary(endpoint, options);
        } catch (error) {
            lastError = error;

            const isLastAttempt = attempt >= RETRY_BACKOFF_MS.length;
            if (isLastAttempt) {
                break;
            }

            const isRetryable =
                (error instanceof ApiError &&
                    RETRYABLE_STATUS_CODES.has(error.statusCode)) ||
                (!(error instanceof ApiError) && error instanceof Error);

            if (!isRetryable) {
                break;
            }

            if (isCliVerboseMode()) {
                cliDebug(
                    `[API] Retry ${attempt + 1}/${RETRY_BACKOFF_MS.length} after ${RETRY_BACKOFF_MS[attempt]}ms`,
                );
            }

            await new Promise((resolve) =>
                setTimeout(resolve, RETRY_BACKOFF_MS[attempt]),
            );
        }
    }

    throw lastError;
}
