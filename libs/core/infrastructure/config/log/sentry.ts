import * as Sentry from '@sentry/nestjs';

let sentryInitialized = false;

/** Headers and query params that identify the caller (Sentry's v10-parity
 *  deny list); auth/token/key values are filtered by Sentry regardless. */
const SENSITIVE_HEADER_TERMS = ['forwarded', '-ip', 'remote-', 'via', '-user'];

/**
 * `enableOpenTelemetrySetup: false` is intentional: Sentry's OTel setup
 * installs a provider whose sampler returns `NOT_RECORD` whenever
 * `tracesSampleRate` is unset (default), before any span processor sees the
 * span. Sentry still captures errors via its own API (`captureException`,
 * etc. — what `reportExceptionToSentry` uses); the OTel side is left to us,
 * so Langfuse registers its own provider and receives every span.
 *
 * `dataCollection` keeps error events to what Sentry 10 sent without
 * `sendDefaultPii`: Sentry 11 collects headers, cookies, every HTTP body,
 * genAI/MCP payloads, query data and stack-frame locals when it is left
 * unset, and those carry customer code and BYOK credentials here.
 *
 * Returns `true` when Sentry was actually initialized (DSN present and
 * `Sentry.init` succeeded). Callers don't need this today, but keeping the
 * signal makes future "is error tracking on?" branches trivial.
 */
export function setupSentry(
    componentType: 'api' | 'worker' | 'webhook',
): boolean {
    if (sentryInitialized) {
        return true;
    }

    const environment =
        process.env.API_NODE_ENV || process.env.NODE_ENV || 'development';

    const dsn = process.env.API_BETTERSTACK_DSN;
    if (!dsn) {
        return false;
    }

    try {
        Sentry.init({
            dsn,
            environment,
            release: `kodus-orchestrator@${
                process.env.SENTRY_RELEASE || environment
            }`,
            serverName: `kodus-${componentType}`,
            initialScope: {
                tags: {
                    component: componentType,
                },
            },
            enableOpenTelemetrySetup: false,
            dataCollection: {
                userInfo: false,
                cookies: false,
                httpHeaders: {
                    request: { deny: SENSITIVE_HEADER_TERMS },
                    response: { deny: SENSITIVE_HEADER_TERMS },
                },
                httpBodies: [],
                urlQueryParams: { deny: SENSITIVE_HEADER_TERMS },
                graphQL: { document: false, variables: false },
                genAI: { inputs: false, outputs: false },
                mcp: { inputs: false, outputs: false },
                databaseQueryData: false,
                queues: false,
                stackFrameVariables: false,
            },
        });

        sentryInitialized = true;
        return true;
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'unknown error';

        console.warn(
            '[Sentry] initialization failed, continuing without error tracking:',
            message,
        );
        return false;
    }
}

interface ReportExceptionOptions {
    context?: string;
    extra?: Record<string, unknown>;
    tags?: Record<string, string | number | boolean>;
}

function withSentryScope(
    options: ReportExceptionOptions,
    callback: () => void,
): void {
    if (!sentryInitialized) {
        return;
    }

    Sentry.withScope((scope) => {
        if (options.context) {
            scope.setTag('context', options.context);
        }

        for (const [key, value] of Object.entries(options.tags ?? {})) {
            scope.setTag(key, String(value));
        }

        for (const [key, value] of Object.entries(options.extra ?? {})) {
            scope.setExtra(key, value);
        }

        callback();
    });
}

async function flushSentry(): Promise<void> {
    try {
        await Sentry.flush(2_000);
    } catch {
        // Keep bootstrap and fatal error flows best-effort.
    }
}

export async function reportExceptionToSentry(
    exception: unknown,
    options: ReportExceptionOptions = {},
): Promise<void> {
    if (!sentryInitialized) {
        return;
    }

    withSentryScope(options, () => {
        Sentry.captureException(
            exception instanceof Error
                ? exception
                : new Error(String(exception)),
        );
    });

    await flushSentry();
}

export async function reportMessageToSentry(
    message: string,
    options: ReportExceptionOptions = {},
): Promise<void> {
    if (!sentryInitialized) {
        return;
    }

    withSentryScope(options, () => {
        Sentry.captureMessage(message);
    });

    await flushSentry();
}
