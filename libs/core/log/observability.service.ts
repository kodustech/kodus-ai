import { getObservability, IdGenerator, StorageEnum } from '@kodus/flow';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConnectionString } from 'connection-string';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';

import { createLogger } from '@kodus/flow';
import { TokenTrackingHandler, BYOKConfig } from '@kodus/kodus-common/llm';
import { CallbackHandler as LangfuseCallbackHandler } from '@langfuse/langchain';
import { shouldTrace } from './langfuse';

/**
 * Narrow projection of BYOKConfig that carries only the fields the
 * observability layer actually needs (provider + model). Everything else —
 * including `apiKey` — is intentionally excluded so that even if a future
 * code change logs the value (span attributes, debug logs, error dumps),
 * customer API keys cannot leak.
 */
type BYOKConfigSafeView = {
    main?: { provider: string; model: string };
    fallback?: { provider: string; model: string };
};

/**
 * Strip everything from a BYOKConfig except provider + model on main/fallback.
 * Returns `undefined` when the input is nullish so downstream code can short-
 * circuit exactly as before.
 */
function toSafeByokView(
    byokConfig?: BYOKConfig,
): BYOKConfigSafeView | undefined {
    if (!byokConfig) return undefined;
    const view: BYOKConfigSafeView = {};
    if (byokConfig.main?.model && byokConfig.main?.provider) {
        view.main = {
            provider: byokConfig.main.provider,
            model: byokConfig.main.model,
        };
    }
    if (byokConfig.fallback?.model && byokConfig.fallback?.provider) {
        view.fallback = {
            provider: byokConfig.fallback.provider,
            model: byokConfig.fallback.model,
        };
    }
    return view.main || view.fallback ? view : undefined;
}

/**
 * Resolves a raw model name (from LangChain) to include the BYOK provider prefix.
 * Matches against main and fallback configs to pick the correct provider.
 */
function resolveModelName(
    rawModel: string,
    byokView?: BYOKConfigSafeView,
): string {
    if (!byokView) return rawModel;
    if (byokView.main?.model === rawModel)
        return `${byokView.main.provider}:${rawModel}`;
    if (byokView.fallback?.model === rawModel)
        return `${byokView.fallback.provider}:${rawModel}`;
    return rawModel;
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
            span.setAttributes(attributes);
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
            byokConfig: finalizeByokConfig,
        }: {
            metadata?: Record<string, any>;
            runName?: string;
            reset?: boolean;
            // Accepts the narrowed safe view (provider + model only). Callers
            // that pass a full BYOKConfig must project through
            // `toSafeByokView` first — see `runLLMInSpan`. Keeping the type
            // narrow here prevents API keys from entering this scope at all.
            byokConfig?: BYOKConfigSafeView;
        } = {}) => {
            const obs = this.getObsInstance();
            const span = obs.getCurrentSpan();

            const {
                runKey,
                runName: resolvedName,
                usages,
            } = tracker.consumeCompletedRunUsages(explicitName ?? runName);

            const s = this.summarize(usages);

            // Resolve model names with BYOK provider prefix when available.
            const resolvedModels = s.modelsArr.map((m) =>
                resolveModelName(m, finalizeByokConfig),
            );
            const resolvedModel = resolvedModels.length
                ? resolvedModels.join(',')
                : undefined;

            if (span) {
                span.setAttributes({
                    'gen_ai.usage.total_tokens': s.totalTokens,
                    'gen_ai.usage.input_tokens': s.inputTokens,
                    'gen_ai.usage.output_tokens': s.outputTokens,
                    ...(s.reasoningTokens > 0 && {
                        'gen_ai.usage.reasoning_tokens': s.reasoningTokens,
                    }),
                    ...(resolvedModel && {
                        'gen_ai.response.model': resolvedModel,
                    }),
                    ...(runKey && { 'gen_ai.run.id': runKey }),
                    ...((explicitName ?? runName ?? resolvedName) && {
                        'gen_ai.run.name':
                            explicitName ?? runName ?? resolvedName,
                    }),
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
                });
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
        byokConfig?: BYOKConfig;
        exec: (callbacks: any[]) => Promise<T>;
    }): Promise<{ result: T; usage: any }> {
        const {
            spanName,
            runName,
            attrs,
            byokConfig: spanByokConfig,
            exec,
        } = params;
        // Scrub the BYOK config immediately so nothing downstream in this
        // span scope — including future debug logs or span attributes —
        // can see the customer's API key. Only provider + model names ride
        // through to `finalize`, which is all the model-name resolver needs.
        const safeByokView = toSafeByokView(spanByokConfig);
        const obs = this.getObsInstance();
        const span = obs.startSpan(spanName);

        try {
            span?.setAttributes?.({
                ...(attrs ?? {}),
                correlationId: obs.getContext()?.correlationId || '',
            });

            const { callbacks, finalize } = this.createLLMTracking(runName);

            // Execute the LLM operation and finalize usage BEFORE span.end() is called by withSpan
            // Note: withSpan handles errors that occur INSIDE the callback (recordException, setStatus, span.end())
            const { result, usage } = await obs.withSpan(span, async () => {
                const result = await exec(callbacks);
                // CRITICAL: finalize() must be called BEFORE withSpan's finally block
                // ends the span, so gen_ai.usage.* attributes are captured
                const usage = await finalize({
                    metadata: attrs,
                    reset: true,
                    byokConfig: safeByokView,
                });
                return { result, usage };
            });

            return { result, usage };
        } catch (error) {
            // If error occurs BEFORE withSpan is called, we need to end the span
            // If error occurs INSIDE withSpan, it already called span.end()
            // So we check if span is still recording before calling end()
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

    private redactConnectionString(value: string | undefined): string | undefined {
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
