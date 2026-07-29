import {
    getObservability,
    IdGenerator,
    StorageEnum,
} from '@libs/core/observability';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionString } from 'connection-string';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';

import { createLogger } from '@libs/core/log/logger';
import { TokenTrackingHandler } from '@kodus/kodus-common/llm';
import { CallbackHandler as LangfuseCallbackHandler } from '@langfuse/langchain';
import { shouldTrace } from './langfuse';
import { deriveTu } from './token-usage-tu';

/**
 * Narrow projection of a resolved BYOK slot — just provider + model. The
 * observability layer receives the resolved slot(s) the run actually used (not
 * the internal `{main,fallback}` intermediate), and `apiKey` is intentionally
 * excluded so that even if a future code change logs the value (span
 * attributes, debug logs, error dumps), customer API keys cannot leak.
 */
type ResolvedModelView = { provider: string; model: string };

/**
 * Keep only the resolved slots that carry both provider + model (dropping
 * everything else, including any `apiKey`). Returns `[]` for a nullish/empty
 * input so downstream code short-circuits exactly as before.
 */
function toResolvedModelViews(
    slots?: Array<{ provider?: string; model?: string } | null | undefined>,
): ResolvedModelView[] {
    if (!slots?.length) return [];
    return slots
        .filter((s): s is ResolvedModelView =>
            Boolean(s?.provider && s?.model),
        )
        .map((s) => ({ provider: s.provider, model: s.model }));
}

/**
 * Resolves a raw model name (from LangChain) to include the BYOK provider
 * prefix by matching it against the resolved slot(s) the run used.
 */
function resolveModelName(
    rawModel: string,
    resolvedModels?: ResolvedModelView[],
): string {
    if (!resolvedModels?.length) return rawModel;
    const match = resolvedModels.find((m) => m.model === rawModel);
    return match ? `${match.provider}:${rawModel}` : rawModel;
}

export type TokenUsage = {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    model?: string;
    runId?: string;
    parentRunId?: string;
    output_reasoning_tokens?: number;
    runName?: string;
};

export interface ObservabilityConfig {
    serviceName: string;
    correlationId?: string;
    threadId?: string;
    enableCollections?: boolean;
    customCollections?: {
        logs?: string;
        telemetry?: string;
    };
    customSettings?: {
        batchSize?: number;
        flushIntervalMs?: number;
        ttlDays?: number;
        samplingRate?: number;
        spanTimeoutMs?: number;
        secondaryIndexes?: string[];
        bucketKeys?: string[];
    };
}

interface UsageSpanInput {
    runName?: string;
    model?: string;
    /** -> `agent.name` column. */
    agentName?: string;
    /** -> `agent.phase` column. */
    phase?: string;
    /** -> `type` column ('system' | 'byok' | 'agent' | ...). */
    type?: string;
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
    organizationId?: string;
    teamId?: string;
    prNumber?: number;
    steps?: number;
    toolCalls?: number;
    finishReason?: string;
    source?: string;
    durationMs?: number;
    extraAttributes?: Record<string, any>;
}

/**
 * THE single source of truth for the `observability_telemetry` cost-span
 * attribute schema (`gen_ai.usage.*` + `agent.name`/`agent.phase`/`type` +
 * cache tokens). Both entry points — `recordAgentRunUsage` (post-hoc) and
 * `runAiSdkLLMInSpan` (wrap-exec) — project through here, so the Mongo columns
 * are identical regardless of how the span is produced. Add a billing
 * attribute ONCE, here. A span carrying `gen_ai.usage.total_tokens` is
 * billing-critical (WAL-backed) per the exporter's `isCriticalSpan`.
 */
function buildUsageSpanAttributes(p: UsageSpanInput): Record<string, any> {
    const u = p.usage;
    const inputTokens = u.inputTokens ?? 0;
    const outputTokens = u.outputTokens ?? 0;
    const totalTokens = u.totalTokens ?? inputTokens + outputTokens;
    const cacheRead = u.cacheReadTokens ?? 0;
    const cacheWrite = u.cacheWriteTokens ?? 0;
    const attrs: Record<string, any> = {
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.total_tokens': totalTokens,
        ...(cacheRead > 0 && {
            'gen_ai.usage.cache_read_input_tokens': cacheRead,
        }),
        ...(cacheWrite > 0 && {
            'gen_ai.usage.cache_creation_input_tokens': cacheWrite,
        }),
        ...((u.reasoningTokens ?? 0) > 0 && {
            'gen_ai.usage.reasoning_tokens': u.reasoningTokens,
        }),
        ...(p.model && { 'gen_ai.response.model': p.model }),
        ...(p.runName && { 'gen_ai.run.name': p.runName }),
        ...(p.agentName && { 'agent.name': p.agentName }),
        ...(p.phase && { 'agent.phase': p.phase }),
        ...(p.type && { type: p.type }),
        ...(p.organizationId && { organizationId: p.organizationId }),
        ...(p.teamId && { teamId: p.teamId }),
        ...(p.prNumber != null && { prNumber: p.prNumber }),
        ...(p.steps != null && { steps: p.steps }),
        ...(p.toolCalls != null && { toolCalls: p.toolCalls }),
        ...(p.finishReason && { finishReason: p.finishReason }),
        ...(p.source && { source: p.source }),
        ...(p.durationMs != null && { durationMs: p.durationMs }),
        ...(p.extraAttributes ?? {}),
    };
    // Mirror LLM-usage into the indexable `attributes.tu` sub-doc so the Token
    // Usage aggregation stays index-covered (see token-usage-tu.ts) — identical
    // numbers, just index-readable. Derived HERE, the single source of truth, so
    // every usage span carries it. deriveTu returns null for non-usage attrs.
    const tu = deriveTu(attrs);
    if (tu) {
        attrs.tu = tu;
    }
    return attrs;
}

@Injectable()
export class ObservabilityService implements OnModuleInit {
    private readonly instances = new Map<
        string,
        ReturnType<typeof getObservability>
    >();

    private currentInstance?: ReturnType<typeof getObservability>;
    private isInitialized = false;

    private static readonly DEFAULT_COLLECTIONS = {
        logs: 'observability_logs_ts',
        telemetry: 'observability_telemetry',
    };

    private static readonly DEFAULT_SETTINGS = {
        batchSize: 75, // Reduced from 150 for more frequent flush (better for LLM spans)
        flushIntervalMs: 3000, // Reduced from 5s to 3s (smaller data loss window)
        ttlDays: 0,
        samplingRate: 1,
        spanTimeoutMs: 10 * 60 * 1000,
        secondaryIndexes: [
            'metadata.component',
            'metadata.tenantId',
            'metadata.organizationId',
            'metadata.teamId',
        ],
        bucketKeys: ['organizationId', 'teamId', 'tenantId'],
    };

    private readonly logger = createLogger(ObservabilityService.name);

    constructor(private readonly configService: ConfigService) {}

    /**
     * NestJS lifecycle hook - Initialize observability automatically when module loads
     * Runs BEFORE onApplicationBootstrap, ensuring observability is ready for all services
     */
    async onModuleInit() {
        const serviceName = process.env.COMPONENT_TYPE || 'unknown';
        await this.init(serviceName);
    }

    /**
     * Initializes the observability engine automatically by fetching configurations from ConfigService.
     * Called automatically via onModuleInit, but can also be called manually in main.ts.
     * @param serviceName Origin name to identify logs (e.g., 'api', 'worker')
     */
    async init(serviceName?: string) {
        if (this.isInitialized) {
            return this.currentInstance || getObservability();
        }

        const mongoConfig =
            this.configService.get<DatabaseConnection>('mongoDatabase');

        const finalName = serviceName
            ? `kodus-${serviceName}`
            : `kodus-${process.env.COMPONENT_TYPE || 'api'}`;

        if (!mongoConfig) {
            this.logger.warn({
                message:
                    'Observability not initialized: mongoDatabase config missing',
                context: ObservabilityService.name,
            });
            return;
        }

        const obs = await this.initializeObservability(mongoConfig, {
            serviceName: finalName,
            enableCollections: true,
        });

        this.isInitialized = true;
        return obs;
    }

    /**
     * Sets the current execution context (correlationId).
     * Used at the beginning of each request or job.
     */
    setContext(correlationId: string, threadId?: string) {
        const obs = this.getObsInstance();
        const ctx = obs.createContext(correlationId);

        if (threadId) {
            (ctx as any).sessionId = threadId;
        }

        obs.setContext(ctx);

        this.logger.debug({
            message: 'Execution context set',
            context: ObservabilityService.name,
            metadata: { correlationId, threadId },
        });
    }

    async initializeObservability(
        config: DatabaseConnection,
        options: ObservabilityConfig,
    ) {
        const correlationId =
            options.correlationId || IdGenerator.correlationId();
        const key = this.makeKey(config, options.serviceName);

        let obs = this.instances.get(key);

        if (!obs) {
            const obsConfig = this.createObservabilityConfig(config, options);

            obs = getObservability(obsConfig);

            try {
                await obs.initialize();
            } catch (error) {
                this.logger.error({
                    message: 'Error initializing observability',
                    context: ObservabilityService.name,
                    error: this.safeErrorForLog(error),
                    metadata: {
                        serviceName: options.serviceName,
                        host: config.host,
                        hasUrl: !!config.url,
                        database: config.database,
                    },
                });
            }

            this.instances.set(key, obs);
            // Set as current instance for all subsequent operations
            this.currentInstance = obs;
        }

        if (correlationId) {
            const ctx = obs.createContext(correlationId);

            if (options.threadId) {
                (ctx as any).sessionId = options.threadId;
            }

            obs.setContext(ctx);
        }

        return obs;
    }

    /**
     * Get the current observability instance (configured with MongoDB)
     * Falls back to global singleton if not initialized (with warning)
     */
    private getObsInstance(): ReturnType<typeof getObservability> {
        if (!this.currentInstance) {
            this.logger.warn({
                message:
                    '⚠️ ObservabilityService used before init() was called - using unconfigured global instance. MongoDB spans may NOT be saved!',
                context: ObservabilityService.name,
                metadata: {
                    stack: new Error().stack,
                },
            });
        }
        return this.currentInstance || getObservability();
    }

    createAgentObservabilityConfig(
        config: DatabaseConnection,
        serviceName: string,
        correlationId?: string,
    ) {
        return this.createObservabilityConfig(config, {
            serviceName,
            correlationId,
            enableCollections: true,
        });
    }

    createPipelineObservabilityConfig(
        config: DatabaseConnection,
        serviceName: string,
        correlationId?: string,
    ) {
        return this.createObservabilityConfig(config, {
            serviceName,
            correlationId,
            enableCollections: true,
            customSettings: { spanTimeoutMs: 15 * 60 * 1000 },
        });
    }

    /**
     * Starts a span and applies initial attributes.
     */
    startSpan(name: string, attributes?: Record<string, any>) {
        const obs = this.getObsInstance();
        const span = obs.startSpan(name);
        if (attributes && typeof span?.setAttributes === 'function') {
            // Mirror LLM-usage into the indexable `attributes.tu` sub-doc so the
            // Token Usage aggregation stays index-covered. deriveTu returns null
            // for spans without usage → non-LLM spans are untouched.
            const tu = deriveTu(attributes);
            span.setAttributes(tu ? { ...attributes, tu } : attributes);
        }
        return span;
    }

    /**
     * Executes a function within a span.
     */
    async runInSpan<T>(
        name: string,
        fn: (span: any) => Promise<T> | T,
        attributes?: Record<string, any>,
    ): Promise<T> {
        const obs = this.getObsInstance();
        const span = this.startSpan(name, {
            ...(attributes ?? {}),
            correlationId: obs.getContext()?.correlationId || '',
        });

        return obs.withSpan(span, async () => {
            try {
                return await fn(span);
            } catch (err: any) {
                span?.setAttributes?.({
                    'error': true,
                    'exception.type': err?.name || 'Error',
                    'exception.message': err?.message || String(err),
                });
                throw err;
            }
        });
    }

    /**
     * Wrap a Vercel AI SDK call (`generateText`/`streamText`) in an LLM billing
     * span so its token usage lands in `observability_telemetry` — the Mongo
     * billing dataset keyed by org/team/PR. This is the parity bridge for agents
     * migrated off the legacy flow-engine LLM adapter: the AI SDK's
     * `telemetry` feeds Langfuse, while this feeds the internal
     * cost pipeline. A span carrying `gen_ai.usage.total_tokens` is treated as
     * billing-critical (synchronously flushed) by the telemetry engine.
     *
     * Usage attributes are read from the AI SDK result's `usage` and projected
     * through `buildUsageSpanAttributes` — the SAME schema `recordAgentRunUsage`
     * uses. `agent.name`/`agent.phase` are derived from `spanName` ('A::B'); the
     * caller's `attrs` (type/org/team/...) are applied by `runInSpan` at span
     * start. Prefer `recordAgentRunUsage` for new harness agents; this wrapper
     * stays for call sites that need to time/guard the exec itself.
     */
    async runAiSdkLLMInSpan<
        T extends {
            usage?: {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                reasoningTokens?: number;
            };
        },
    >(params: {
        spanName: string;
        runName?: string;
        model?: string;
        attrs?: Record<string, any>;
        exec: () => Promise<T>;
    }): Promise<T> {
        const [agentName, phase] = params.spanName.split('::');
        return this.runInSpan(
            params.spanName,
            async (span) => {
                const result = await params.exec();
                const usage = result?.usage;
                span?.setAttributes?.(
                    buildUsageSpanAttributes({
                        runName: params.runName,
                        model: params.model,
                        agentName,
                        phase,
                        usage: {
                            inputTokens: usage?.inputTokens,
                            outputTokens: usage?.outputTokens,
                            totalTokens: usage?.totalTokens,
                            // ai@7: nested details; ai@6: top-level fields.
                            reasoningTokens:
                                (
                                    usage as
                                        | {
                                              outputTokenDetails?: {
                                                  reasoningTokens?: number;
                                              };
                                              reasoningTokens?: number;
                                          }
                                        | undefined
                                )?.outputTokenDetails?.reasoningTokens ??
                                usage?.reasoningTokens,
                            cacheReadTokens:
                                (
                                    usage as
                                        | {
                                              inputTokenDetails?: {
                                                  cacheReadTokens?: number;
                                              };
                                              cachedInputTokens?: number;
                                          }
                                        | undefined
                                )?.inputTokenDetails?.cacheReadTokens ??
                                (
                                    usage as
                                        | { cachedInputTokens?: number }
                                        | undefined
                                )?.cachedInputTokens,
                        },
                    }),
                );
                return result;
            },
            params.attrs,
        );
    }

    /**
     * Canonical agent-run cost span — the SINGLE source of truth for the
     * `observability_telemetry` billing schema (Mongo). Every agent built on
     * the harness (`AiSdkAgentRunner`) calls this once per logical phase after
     * the run, passing the usage read from `RunState.usage`, so the columns the
     * `mongodb-exporter` projects (`agentName`, `phase`, `type`, the
     * `gen_ai.usage.*` family, cache tokens) are populated identically for
     * code-review, conversation, business-rules and any future agent.
     *
     * Boundary note: this method is deliberately domain-agnostic — it takes
     * plain fields, never a review/conversation shape. The harness stays free
     * of observability and the domain stays free of the span schema; both meet
     * here. A span carrying `gen_ai.usage.total_tokens` is billing-critical
     * (WAL-backed, never dropped) per the exporter's `isCriticalSpan`.
     *
     * Best-effort: observability must never break an agent run, so all failures
     * are swallowed.
     */
    async recordAgentRunUsage(params: {
        /** Logical agent identity -> `agent.name` column. */
        agentName: string;
        /** Run sub-phase -> `agent.phase` column (e.g. 'review','verify','conversation','business-rules'). */
        phase: string;
        /** Span NAME (the `name` column). Defaults to `${agentName}::${phase}`.
         *  Override to preserve an existing span name that dashboards query. */
        spanName?: string;
        /** Human label -> `gen_ai.run.name`. Defaults to `${agentName}-${phase}`. */
        runName?: string;
        /** Resolved model -> `gen_ai.response.model`. */
        model?: string;
        /** byok config present -> `type: 'byok'`, else `'system'`. */
        isByok: boolean;
        usage: {
            inputTokens?: number;
            outputTokens?: number;
            totalTokens?: number;
            reasoningTokens?: number;
            cacheReadTokens?: number;
            cacheWriteTokens?: number;
        };
        organizationId?: string;
        teamId?: string;
        prNumber?: number;
        steps?: number;
        toolCalls?: number;
        finishReason?: string;
        source?: string;
        durationMs?: number;
        /** Escape hatch for domain-specific low-cardinality attributes. */
        extraAttributes?: Record<string, any>;
    }): Promise<void> {
        try {
            await this.runInSpan(
                params.spanName ?? `${params.agentName}::${params.phase}`,
                async () => undefined,
                buildUsageSpanAttributes({
                    runName:
                        params.runName ?? `${params.agentName}-${params.phase}`,
                    model: params.model,
                    agentName: params.agentName,
                    phase: params.phase,
                    type: params.isByok ? 'byok' : 'system',
                    usage: params.usage,
                    organizationId: params.organizationId,
                    teamId: params.teamId,
                    prNumber: params.prNumber,
                    steps: params.steps,
                    toolCalls: params.toolCalls,
                    finishReason: params.finishReason,
                    source: params.source,
                    durationMs: params.durationMs,
                    extraAttributes: params.extraAttributes,
                }),
            );
        } catch {
            // Observability is best-effort — never break an agent run.
        }
    }

    // ---------- Integrated LLM tracking ----------

    createLLMTracking(runName?: string) {
        const tracker = new TokenTrackingHandler();
        const callbacks: any[] = [tracker];
        if (shouldTrace()) {
            callbacks.push(
                new LangfuseCallbackHandler({
                    tags: runName ? [runName] : undefined,
                }),
            );
        }

        const finalize = async ({
            metadata,
            runName: explicitName,
            reset,
            resolvedModels,
        }: {
            metadata?: Record<string, any>;
            runName?: string;
            reset?: boolean;
            resolvedModels?: ResolvedModelView[];
        } = {}) => {
            const obs = this.getObsInstance();
            const span = obs.getCurrentSpan();

            const {
                runKey,
                runName: resolvedName,
                usages,
            } = tracker.consumeCompletedRunUsages(explicitName ?? runName);

            const s = this.summarize(usages);

            // Prefix each raw model name with its BYOK provider by matching
            // against the resolved slot(s) the run used.
            const prefixedModels = s.modelsArr.map((m) =>
                resolveModelName(m, resolvedModels),
            );
            const resolvedModel = prefixedModels.length
                ? prefixedModels.join(',')
                : undefined;

            if (span) {
                // Same schema as the AI SDK / harness paths — project through the
                // single source of truth (buildUsageSpanAttributes) so the Mongo
                // cost columns are identical regardless of capture method (it
                // also mirrors the indexable `attributes.tu` sub-doc). Only the
                // LangChain-specific extras (run.id / runIds / names) and the
                // caller metadata go through extraAttributes.
                span.setAttributes(
                    buildUsageSpanAttributes({
                        runName: explicitName ?? runName ?? resolvedName,
                        model: resolvedModel,
                        usage: {
                            inputTokens: s.inputTokens,
                            outputTokens: s.outputTokens,
                            totalTokens: s.totalTokens,
                            reasoningTokens: s.reasoningTokens,
                        },
                        extraAttributes: {
                            ...(runKey && { 'gen_ai.run.id': runKey }),
                            ...(s.runIdsArr.length && {
                                runIds: s.runIdsArr.join(','),
                            }),
                            ...(s.parentRunIdsArr.length && {
                                parentRunIds: s.parentRunIdsArr.join(','),
                            }),
                            ...(s.runNamesArr.length && {
                                runNames: s.runNamesArr.join(','),
                            }),
                            ...(metadata ?? {}),
                        },
                    }),
                );
            }

            if (reset) {
                tracker.reset(runKey ?? undefined);
            }

            return {
                runKey,
                runName: resolvedName ?? runName,
                usages,
                summary: s,
            };
        };

        return { callbacks, tracker, finalize };
    }

    async runLLMInSpan<T>(params: {
        spanName: string;
        runName?: string;
        attrs?: Record<string, any>;
        /** The resolved slot(s) the run used — provider+model only, never a key. */
        resolvedModels?: Array<{ provider?: string; model?: string }>;
        exec: (callbacks: any[]) => Promise<T>;
    }): Promise<{ result: T; usage: any }> {
        const { spanName, runName, attrs, resolvedModels, exec } = params;
        const resolvedModelViews = toResolvedModelViews(resolvedModels);
        const obs = this.getObsInstance();
        const span = obs.startSpan(spanName);

        try {
            span?.setAttributes?.({
                ...(attrs ?? {}),
                correlationId: obs.getContext()?.correlationId || '',
            });

            const { callbacks, finalize } = this.createLLMTracking(runName);

            const { result, usage } = await obs.withSpan(span, async () => {
                const result = await exec(callbacks);
                const usage = await finalize({
                    metadata: attrs,
                    reset: true,
                    resolvedModels: resolvedModelViews,
                });
                return { result, usage };
            });

            return { result, usage };
        } catch (error) {
            if (span?.isRecording?.()) {
                span.end();
            }
            throw error;
        }
    }

    // ---------- Helpers privados ----------

    private createObservabilityConfig(
        config: DatabaseConnection,
        options: ObservabilityConfig,
    ) {
        const uri = this.buildConnectionString(config);
        // Emergency kill-switch: be liberal in what counts as "off" (this is
        // the operational escape hatch for the observability OOM path, so a
        // mistyped `FALSE`/`0` must not silently leave it enabled). Default
        // (unset) stays enabled.
        const mongoEnabledFlag =
            process.env.OBSERVABILITY_MONGO_ENABLED?.trim().toLowerCase();
        const mongoExporterEnabled =
            mongoEnabledFlag !== 'false' &&
            mongoEnabledFlag !== '0' &&
            mongoEnabledFlag !== 'off' &&
            mongoEnabledFlag !== 'no';

        const collections =
            options.enableCollections !== false
                ? {
                      logs:
                          options.customCollections?.logs ??
                          ObservabilityService.DEFAULT_COLLECTIONS.logs,
                      telemetry:
                          options.customCollections?.telemetry ??
                          ObservabilityService.DEFAULT_COLLECTIONS.telemetry,
                  }
                : undefined;

        return {
            logging: { enabled: true },
            ...(mongoExporterEnabled && {
                mongodb: {
                    type: 'mongodb' as const,
                    connectionString: uri,
                    database: config.database,
                    ...(collections && { collections }),
                    batchSize:
                        options.customSettings?.batchSize ??
                        ObservabilityService.DEFAULT_SETTINGS.batchSize,
                    flushIntervalMs:
                        options.customSettings?.flushIntervalMs ??
                        ObservabilityService.DEFAULT_SETTINGS.flushIntervalMs,
                    ttlDays: 0,
                    enableObservability: true,
                    secondaryIndexes:
                        options.customSettings?.secondaryIndexes ??
                        ObservabilityService.DEFAULT_SETTINGS.secondaryIndexes,
                    bucketKeys:
                        options.customSettings?.bucketKeys ??
                        ObservabilityService.DEFAULT_SETTINGS.bucketKeys,
                },
            }),
            telemetry: {
                enabled: true,
                serviceName: options.serviceName,
                sampling: {
                    rate:
                        options.customSettings?.samplingRate ??
                        ObservabilityService.DEFAULT_SETTINGS.samplingRate,
                    strategy: 'probabilistic' as const,
                },
                privacy: { includeSensitiveData: false },
                ...(options.customSettings?.spanTimeoutMs && {
                    spanTimeouts: {
                        enabled: true,
                        maxDurationMs: options.customSettings.spanTimeoutMs,
                    },
                }),
            },
        };
    }

    public buildConnectionString(config: DatabaseConnection): string {
        if (config?.url) {
            return config.url;
        }

        if (!config?.host) {
            throw new Error(
                'ObservabilityService: invalid DatabaseConnection — provide either `url` or `host`',
            );
        }

        const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;

        let uri = new ConnectionString('', {
            user: config.username,
            password: config.password,
            protocol: config.port ? 'mongodb' : 'mongodb+srv',
            hosts: [{ name: config.host, port: config.port }],
        }).toString();

        const shouldAppendClusterConfig =
            !['development', 'test'].includes(env ?? '') &&
            !!process.env.API_MG_DB_PRODUCTION_CONFIG;

        if (shouldAppendClusterConfig) {
            uri = `${uri}/${process.env.API_MG_DB_PRODUCTION_CONFIG}`;
        }

        return uri;
    }

    public getConnectionString(): string {
        const mongoConfig =
            this.configService.get<DatabaseConnection>('mongoDatabase');

        if (!mongoConfig) {
            this.logger.error({
                message:
                    'MongoDB connection string requested but config is missing',
                context: ObservabilityService.name,
            });
            throw new Error('mongoDatabase configuration is not available.');
        }

        return this.buildConnectionString(mongoConfig);
    }

    public getAgentObservabilityConfig(
        serviceName: string,
        correlationId?: string,
    ) {
        const mongoConfig =
            this.configService.get<DatabaseConnection>('mongoDatabase');
        if (!mongoConfig) {
            throw new Error('mongoDatabase configuration is not available.');
        }
        return this.createAgentObservabilityConfig(
            mongoConfig,
            serviceName,
            correlationId,
        );
    }

    public getStorageConfig() {
        const mongoConfig =
            this.configService.get<DatabaseConnection>('mongoDatabase');
        if (!mongoConfig) {
            throw new Error('mongoDatabase configuration is not available.');
        }
        return {
            type: StorageEnum.MONGODB,
            connectionString: this.getConnectionString(),
            database: mongoConfig.database,
        };
    }

    private summarize(usages: TokenUsage[]) {
        const acc = {
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            models: new Set<string>(),
            runIds: new Set<string>(),
            parentRunIds: new Set<string>(),
            runNames: new Set<string>(),
            details: [] as TokenUsage[],
        };
        for (const u of usages) {
            const input = u.input_tokens ?? 0;
            const output = u.output_tokens ?? 0;
            const reasoning = (u as any).output_reasoning_tokens ?? 0;
            const total = u.total_tokens ?? input + output;
            if (u.model) {
                acc.models.add(u.model);
            }
            if (u.runId) {
                acc.runIds.add(u.runId);
            }
            if (u.parentRunId) {
                acc.parentRunIds.add(u.parentRunId);
            }
            if (u.runName) {
                acc.runNames.add(u.runName);
            }
            acc.totalTokens += total;
            acc.inputTokens += input;
            acc.outputTokens += output;
            acc.reasoningTokens += reasoning;
            acc.details.push(u);
        }
        return {
            ...acc,
            modelsArr: Array.from(acc.models),
            runIdsArr: Array.from(acc.runIds),
            parentRunIdsArr: Array.from(acc.parentRunIds),
            runNamesArr: Array.from(acc.runNames),
        };
    }

    private redactConnectionString(
        value: string | undefined,
    ): string | undefined {
        if (!value) return value;
        return value.replace(
            /\b(mongodb(?:\+srv)?:\/\/)[^\s:@/]+:[^\s@/]+@/gi,
            '$1***:***@',
        );
    }

    private safeErrorForLog(err: unknown): Error {
        const source = err instanceof Error ? err : new Error(String(err));
        const redacted = new Error(
            this.redactConnectionString(source.message) ?? '',
        );
        redacted.name = source.name;
        redacted.stack = this.redactConnectionString(source.stack);
        return redacted;
    }

    private makeKey(config: DatabaseConnection, serviceName: string): string {
        return JSON.stringify({
            u: config.url ?? null,
            h: config.host ?? null,
            p: config.port ?? null,
            db: config.database ?? null,
            s: serviceName,
        });
    }

    async ensureContext(
        config: DatabaseConnection,
        serviceName: string,
        correlationId?: string,
    ) {
        await this.initializeObservability(config, {
            serviceName,
            correlationId: correlationId || IdGenerator.correlationId(),
        });
    }
}
