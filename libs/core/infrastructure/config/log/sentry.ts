import * as Sentry from '@sentry/nestjs';

let sentryInitialized = false;

/**
 * `skipOpenTelemetrySetup` is intentional: Sentry's OTel setup installs a
 * `BasicTracerProvider` whose `SentrySampler` returns `NOT_RECORD` whenever
 * `tracesSampleRate` is unset (default), and that decision is made *before*
 * any registered span processor sees the span — so injecting Langfuse via
 * `openTelemetrySpanProcessors` resulted in the processor being attached
 * but never invoked. With `skipOpenTelemetrySetup: true` Sentry still
 * captures errors via its own API (`captureException`, etc. — what
 * `reportExceptionToSentry` uses); only the OTel side is left to us, so
 * Langfuse can register its own provider unconditionally and receive every
 * span without going through Sentry's sampler.
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
            skipOpenTelemetrySetup: true,
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
