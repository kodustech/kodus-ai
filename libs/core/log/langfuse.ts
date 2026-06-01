import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { AttributeValue } from '@opentelemetry/api';

let spanProcessor: LangfuseSpanProcessor | null = null;
let ownTracerProvider: NodeTracerProvider | null = null;
let beforeExitInstalled = false;

export function shouldTrace(): boolean {
    return (
        process.env.LANGFUSE_TRACING === 'true' &&
        !!process.env.LANGFUSE_PUBLIC_KEY &&
        !!process.env.LANGFUSE_SECRET_KEY
    );
}

/**
 * `beforeExit` fires when Node's event loop drains and the process is about
 * to exit naturally — including the path taken when `uncaughtException` /
 * `unhandledRejection` are swallowed by the global handlers in each
 * app's `main.ts` and the app then quiesces. SIGTERM/SIGINT graceful
 * shutdowns go through `LangfuseShutdownProvider` instead.
 *
 * Idempotent: only installs once per process.
 */
function installBeforeExitFlush(): void {
    if (beforeExitInstalled) return;
    beforeExitInstalled = true;

    process.on('beforeExit', async () => {
        await flushLangfuse();
    });
}

/**
 * Build (and cache) the `LangfuseSpanProcessor` without registering it on a
 * TracerProvider. The processor must be wired into the global provider by
 * the caller — either via `Sentry.init({ openTelemetrySpanProcessors })`
 * when Sentry's OTel setup runs, or via `registerLangfuseStandalone()`
 * when it doesn't.
 *
 * Why split create from register: `@opentelemetry/sdk-trace-base@2.x`
 * removed `addSpanProcessor` from `BasicTracerProvider`, so processors can
 * only be passed via constructor `spanProcessors`. And once Sentry calls
 * `trace.setGlobalTracerProvider(...)`, the OTel ProxyTracerProvider
 * silently ignores any later `register()` — meaning a NodeTracerProvider
 * spun up after Sentry never receives spans. This function defers that
 * choice to the caller, where the order is known.
 *
 * Returns `null` when tracing is disabled (env vars unset). Idempotent.
 */
export function createLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
    if (spanProcessor) return spanProcessor;
    if (!shouldTrace()) return null;

    spanProcessor = new LangfuseSpanProcessor({
        environment:
            process.env.LANGFUSE_ENVIRONMENT ??
            process.env.API_NODE_ENV ??
            'development',
    });

    installBeforeExitFlush();
    return spanProcessor;
}

/**
 * Register the Langfuse span processor on a dedicated `NodeTracerProvider`
 * and install it as the global provider. Use only when Sentry's OTel setup
 * did NOT run (no DSN configured) — otherwise the second
 * `trace.setGlobalTracerProvider` call is silently rejected by the OTel
 * ProxyTracerProvider and spans never reach Langfuse. When Sentry runs,
 * pass the processor to `Sentry.init({ openTelemetrySpanProcessors })`
 * instead so Sentry's own provider fans spans out to both.
 *
 * Idempotent.
 */
export function registerLangfuseStandalone(): void {
    if (ownTracerProvider) return;
    const processor = createLangfuseSpanProcessor();
    if (!processor) return;

    ownTracerProvider = new NodeTracerProvider({
        spanProcessors: [processor],
    });
    ownTracerProvider.register();
}

export async function flushLangfuse(): Promise<void> {
    if (!spanProcessor) return;
    try {
        await spanProcessor.forceFlush();
    } catch {
        // best-effort flush on shutdown
    }
}

export async function shutdownLangfuse(): Promise<void> {
    if (ownTracerProvider) {
        try {
            await ownTracerProvider.shutdown();
        } catch {
            // best-effort
        }
        ownTracerProvider = null;
    }
    spanProcessor = null;
}

export interface LangfuseTelemetryMetadata {
    organizationId?: string;
    teamId?: string;
    pullRequestId?: number;
    repositoryId?: string;
    provider?: string;
}

/**
 * Build the `experimental_telemetry` config for a Vercel AI SDK call.
 * `functionId` sets the observation name in Langfuse; `metadata` shows up
 * in the Metadata tab. Safe to call when tracing is disabled — the AI SDK
 * reads `isEnabled` and skips span emission.
 */
export function buildLangfuseTelemetry(
    functionId: string,
    metadata?: LangfuseTelemetryMetadata,
): {
    isEnabled: boolean;
    functionId: string;
    metadata?: Record<string, AttributeValue>;
} {
    const attrs: Record<string, AttributeValue> = {};
    if (metadata?.organizationId) attrs.organizationId = metadata.organizationId;
    if (metadata?.teamId) attrs.teamId = metadata.teamId;
    if (metadata?.pullRequestId !== undefined)
        attrs.pullRequestId = metadata.pullRequestId;
    if (metadata?.repositoryId) attrs.repositoryId = metadata.repositoryId;
    if (metadata?.provider) attrs.provider = metadata.provider;
    return {
        isEnabled: shouldTrace(),
        functionId,
        ...(Object.keys(attrs).length > 0 && { metadata: attrs }),
    };
}
