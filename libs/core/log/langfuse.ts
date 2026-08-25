import { LangfuseSpanProcessor } from '@langfuse/otel';
import { propagateAttributes } from '@langfuse/tracing';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { AttributeValue } from '@opentelemetry/api';
import { registerTelemetry, type TelemetryOptions } from 'ai';

let spanProcessor: LangfuseSpanProcessor | null = null;
let ownTracerProvider: NodeTracerProvider | null = null;
let beforeExitInstalled = false;
let aiSdkTelemetryRegistered = false;

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

/**
 * Register Langfuse's AI SDK 7 telemetry integration once at process start.
 * AI SDK 7 uses a callback-based telemetry registry (`registerTelemetry`);
 * without this, `telemetry` / `experimental_telemetry` on generateText never
 * emit OTEL spans — only manual `@langfuse/tracing` observations show up.
 *
 * Call after `registerLangfuseStandalone()` (or Sentry OTel wiring) so the
 * global TracerProvider already has the Langfuse span processor.
 * Idempotent; no-op when tracing is disabled.
 */
export function registerLangfuseAiSdkTelemetry(): void {
    if (aiSdkTelemetryRegistered) return;
    if (!shouldTrace()) return;

    registerTelemetry(new LangfuseVercelAiSdkIntegration());
    aiSdkTelemetryRegistered = true;
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

/** Trace-level attributes — the Langfuse dimensions you filter and group BY
 *  (user, session, tags), as opposed to the per-observation metadata that
 *  `buildLangfuseTelemetry` carries. Different plane, different API: the SDK
 *  telemetry option cannot set these. */
export interface LangfuseTraceAttributes {
    /** Names the trace in the UI. */
    traceName: string;
    /** Groups traces the UI shows as one unit of work (a conversation thread,
     *  a pull request). */
    sessionId?: string;
    /** Whom the trace belongs to — we scope by organization, not end user. */
    userId?: string;
    /** Langfuse keeps string values only (≤200 chars) and warns on anything
     *  else, so absent identifiers are dropped rather than sent as "undefined"
     *  — see `withLangfuseTrace`. */
    metadata?: Record<string, string | undefined>;
    tags?: string[];
}

/**
 * The Langfuse session key for a pull-request-scoped run.
 *
 * Every agent working on the same PR MUST derive the key here: Langfuse groups
 * traces into a session by exact string match, so a second spelling silently
 * splits one PR into two sessions instead of failing loudly. Returns undefined
 * when there is no PR to scope to — a session is not invented for a run that
 * has nothing to group with.
 */
export function pullRequestSessionId(meta: {
    organizationId?: string;
    repositoryId?: string;
    pullRequestId?: number | string;
}): string | undefined {
    if (!meta.pullRequestId) {
        return undefined;
    }
    return `${meta.organizationId || 'unknown_org'}:${meta.repositoryId ?? 'repo'}:${meta.pullRequestId}`;
}

/**
 * Run `fn` with Langfuse trace-level attributes propagated to every span it
 * opens — including the AI SDK spans the agent runner produces downstream.
 *
 * Pass-through no-op when tracing is disabled, so callers wrap unconditionally
 * and pay nothing when Langfuse is off.
 */
export function withLangfuseTrace<T>(
    attrs: LangfuseTraceAttributes,
    fn: () => Promise<T>,
): Promise<T> {
    if (!shouldTrace()) {
        return fn();
    }
    const { metadata, ...rest } = attrs;
    return propagateAttributes(
        {
            ...rest,
            ...(metadata
                ? {
                      metadata: Object.fromEntries(
                          Object.entries(metadata).filter(
                              (entry): entry is [string, string] =>
                                  entry[1] !== undefined,
                          ),
                      ),
                  }
                : {}),
        },
        fn,
    );
}

export interface LangfuseTelemetryMetadata {
    organizationId?: string;
    teamId?: string;
    pullRequestId?: number;
    repositoryId?: string;
    provider?: string;
}

/** Declared as a type alias (not an interface) on purpose: aliases get an
 *  implicit index signature, so this stays assignable to the harness's opaque
 *  `Readonly<Record<string, unknown>>` telemetry slot. */
export type LangfuseTelemetryConfig = {
    isEnabled: boolean;
    functionId: string;
    /** Carried for AI SDK 7 via `runtimeContext` (see `toAiSdkTelemetryArgs`). */
    metadata?: Record<string, AttributeValue>;
};

/**
 * Build Langfuse telemetry knobs for a Vercel AI SDK call.
 * `functionId` sets the observation name; optional `metadata` is applied as
 * AI SDK 7 `runtimeContext` via `toAiSdkTelemetryArgs` (not the removed
 * `telemetry.metadata` field). Safe when tracing is disabled — `isEnabled`
 * opts the call out.
 */
export function buildLangfuseTelemetry(
    functionId: string,
    metadata?: LangfuseTelemetryMetadata,
): LangfuseTelemetryConfig {
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

/**
 * Expand `buildLangfuseTelemetry()` into AI SDK 7 call fields — the ONE place
 * that knows how Langfuse metadata maps onto the SDK. Spreads as
 * `{ telemetry, runtimeContext? }` into `generateText`/`generateObject`, or
 * into an `AgentRunInput` for a harness run; both forward it verbatim.
 *
 * The return type is the SDK's own `TelemetryOptions`, so a telemetry redesign
 * in a future `ai` major fails here at compile time instead of silently
 * dropping attributes at runtime.
 */
export function toAiSdkTelemetryArgs(config: LangfuseTelemetryConfig): {
    telemetry: TelemetryOptions;
    runtimeContext?: Record<string, AttributeValue>;
} {
    const { isEnabled, functionId, metadata } = config;
    if (!metadata || Object.keys(metadata).length === 0) {
        return { telemetry: { isEnabled, functionId } };
    }
    return {
        telemetry: {
            isEnabled,
            functionId,
            includeRuntimeContext: Object.fromEntries(
                Object.keys(metadata).map((k) => [k, true as const]),
            ),
        },
        runtimeContext: metadata,
    };
}
