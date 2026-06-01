import {
    TraceItem,
    LogProcessor,
    ObservabilityExporter,
    TraceItem as TraceItemType,
    LogContext,
    AGENT,
    TOOL,
    GEN_AI,
} from '../types.js';
import { createLogger, deepSanitize } from '../logger.js';
import {
    LogLevel,
    MongoDBExporterConfig,
    MongoDBLogItem,
    MongoDBTelemetryItem,
    ObservabilityStorageConfig,
} from '../../core/types/allTypes.js';
import { promises as fs } from 'fs';
import { EOL, tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export class MongoDBExporter implements LogProcessor, ObservabilityExporter {
    public readonly name = 'MongoDBExporter';
    private config: MongoDBExporterConfig;
    private logger: ReturnType<typeof createLogger>;

    private client: any = null;

    private db: any = null;
    private collections: {
        logs: any;
        telemetry: any;
    } | null = null;

    // Dual Buffers: Critical (LLM) vs Normal
    private logBuffer: MongoDBLogItem[] = [];
    private criticalTelemetryBuffer: MongoDBTelemetryItem[] = []; // LLM spans (billing)
    private normalTelemetryBuffer: MongoDBTelemetryItem[] = []; // Normal spans
    private readonly maxBufferSize = 5000; // Normal buffer
    private readonly maxCriticalBufferSize = 10000; // Critical buffer (larger, never discards)

    // Flush timers
    private logFlushTimer: NodeJS.Timeout | null = null;
    private telemetryFlushTimer: NodeJS.Timeout | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;

    private isFlushingLogs = false;
    private isFlushingTelemetry = false;

    // Write-Ahead Log (WAL) for critical spans
    private walEnabled = true;
    private walPath =
        process.env.KODUS_WAL_PATH ||
        join(
            process.env.KODUS_DATA_DIR || tmpdir(),
            'kodus-wal-critical-spans.jsonl',
        );
    // P0 #1: when we start a flush we rename walPath → walProcessingPath
    // so the next writeToWal lands in a fresh walPath while the current
    // batch is in flight. Recovery reads both files so a crash between
    // rename and unlink doesn't drop spans.
    private walProcessingPath = this.walPath + '.processing';
    // P0 #3: replay WAL exactly once per process. Subsequent reconnects
    // must NOT re-feed the buffer with the same spans — that's how a
    // 3-reconnect outage tripled the critical buffer in prod.
    private walRecovered = false;
    // P0 #2: caps prevent the on-disk files from growing unbounded
    // during long outages. Hard-coded — operators don't need to tune
    // these and the previous instinct to add envs was rejected.
    private readonly walMaxBytes = 100 * 1024 * 1024; // 100MB
    private readonly dlqMaxBytes = 100 * 1024 * 1024; // 100MB
    private readonly dlqMaxRotatedFiles = 5;
    private dlqPath =
        process.env.KODUS_DLQ_PATH ||
        join(
            process.env.KODUS_DATA_DIR || tmpdir(),
            'kodus-dlq-overflow.jsonl',
        );

    private isInitialized = false;
    private reconnectInProgress = false;
    private lastReconnectAt = 0;
    private readonly reconnectDelayMs = 5000;

    // Circuit Breaker state
    private circuitBreakerState: 'closed' | 'open' | 'half-open' = 'closed';
    private failureCount = 0;
    private readonly failureThreshold = 5; // Open circuit after 5 failures
    private readonly resetTimeout = 30000; // Try to close circuit after 30s
    private lastFailureTime = 0;
    private successCount = 0;

    constructor(config: Partial<MongoDBExporterConfig> = {}) {
        this.config = {
            connectionString: 'mongodb://localhost:27017/kodus',
            database: 'kodus',
            collections: {
                logs: 'observability_logs_ts',
                telemetry: 'observability_telemetry',
            },
            batchSize: 50,
            flushIntervalMs: 15000,
            maxRetries: 3,
            ttlDays: 0, // Disabled by default (Infinite retention)
            enableObservability: true,
            ...config,
        };

        this.logger = createLogger('mongodb-exporter');
    }

    /**
     * Identifies if a span is critical (LLM = billing)
     */
    private isCriticalSpan(item: MongoDBTelemetryItem): boolean {
        return !!item.attributes?.[GEN_AI.USAGE_TOTAL_TOKENS];
    }

    /**
     * WAL: Writes critical span to local file (async, non-blocking)
     */
    private async writeToWal(item: MongoDBTelemetryItem): Promise<void> {
        if (!this.walEnabled) return;

        try {
            // P0 #2: enforce a size cap. If the WAL would grow past the
            // configured limit, drop oldest content first (rename →
            // truncate strategy). Without this, a multi-day Mongo outage
            // produces a multi-GB WAL that OOMs the process on next boot
            // via `recoverFromWal`'s readFile.
            await this.rotateWalIfOversized();

            const line = JSON.stringify(item) + EOL;
            await fs.appendFile(this.walPath, line, 'utf8');
        } catch (error) {
            // Should not crash if WAL fails, but logs the error
            this.logger.error({
                message: 'Failed to write to WAL',
                context: this.constructor.name,
                error: error as Error,
            });
        }
    }

    /**
     * Drop the oldest half of WAL content when the file exceeds the
     * configured size cap. We trim instead of full-truncate so that
     * recent spans (more likely to be replayable) survive.
     * P0 #2.
     */
    private async rotateWalIfOversized(): Promise<void> {
        try {
            const stat = await fs.stat(this.walPath);
            if (stat.size <= this.walMaxBytes) return;
            // Stream from the middle of the file to a temp, then atomic
            // rename. Cheap enough since this only runs when oversized.
            const targetStart = Math.floor(stat.size / 2);
            const tmp = this.walPath + '.trim';
            const readline = await import('readline');
            const { createReadStream, createWriteStream } = await import('fs');
            const input = createReadStream(this.walPath, {
                start: targetStart,
                encoding: 'utf8',
            });
            const output = createWriteStream(tmp, { encoding: 'utf8' });
            // Skip the partial first line at our offset — it's almost
            // certainly mid-JSON. The next newline starts a clean span.
            let droppedPartial = false;
            const rl = readline.createInterface({ input });
            await new Promise<void>((resolve, reject) => {
                rl.on('line', (line) => {
                    if (!droppedPartial) {
                        droppedPartial = true;
                        return;
                    }
                    if (line.trim().length > 0) output.write(line + EOL);
                });
                rl.on('close', () => {
                    output.end(resolve);
                });
                rl.on('error', reject);
                output.on('error', reject);
            });
            await fs.rename(tmp, this.walPath);
            this.logger.warn({
                message:
                    'WAL exceeded configured size cap — trimmed oldest half',
                context: this.constructor.name,
                metadata: {
                    walPath: this.walPath,
                    previousBytes: stat.size,
                    capBytes: this.walMaxBytes,
                },
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') return;
            this.logger.warn({
                message: 'WAL rotation failed; will retry on next write',
                context: this.constructor.name,
                error: error as Error,
            });
        }
    }

    /**
     * Read one WAL file via streaming readline so a very large WAL
     * doesn't allocate the whole file into memory (P0 #2).
     * Returns the count of spans pushed onto criticalTelemetryBuffer.
     */
    private async drainWalFile(path: string): Promise<number> {
        let recovered = 0;
        try {
            const readline = await import('readline');
            const { createReadStream } = await import('fs');
            const input = createReadStream(path, { encoding: 'utf8' });
            const rl = readline.createInterface({ input });
            for await (const line of rl) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const item = JSON.parse(trimmed) as MongoDBTelemetryItem;
                    this.criticalTelemetryBuffer.push(item);
                    recovered++;
                } catch (parseError) {
                    this.logger.warn({
                        message: 'Failed to parse WAL line — skipping',
                        context: this.constructor.name,
                        error: parseError as Error,
                    });
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error({
                    message: `Failed to drain WAL file ${path}`,
                    context: this.constructor.name,
                    error: error as Error,
                });
            }
        }
        return recovered;
    }

    /**
     * WAL: Recovers critical spans from local files.
     *
     * P0 #1: drains BOTH walPath and walProcessingPath so a crash
     * between rename and unlink doesn't drop spans.
     *
     * P0 #3: idempotent — replay happens once per process. Subsequent
     * reconnects skip; otherwise an outage with 3 reconnect attempts
     * triples the critical buffer with already-recovered spans.
     */
    private async recoverFromWal(): Promise<void> {
        if (!this.walEnabled) return;
        if (this.walRecovered) return;

        const fromProcessing = await this.drainWalFile(this.walProcessingPath);
        const fromMain = await this.drainWalFile(this.walPath);
        const total = fromProcessing + fromMain;

        if (total > 0) {
            this.logger.log({
                message: `WAL recovery complete: ${total} spans recovered (${fromProcessing} from in-flight, ${fromMain} from main)`,
                context: this.constructor.name,
            });
        }

        // Now that everything is in-memory, remove both files. They'll
        // get rebuilt by writeToWal as new spans arrive.
        await this.unlinkSilently(this.walProcessingPath);
        await this.unlinkSilently(this.walPath);

        this.walRecovered = true;
    }

    private async unlinkSilently(path: string): Promise<void> {
        try {
            await fs.unlink(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.warn({
                    message: `Failed to unlink ${path}`,
                    context: this.constructor.name,
                    error: error as Error,
                });
            }
        }
    }

    /**
     * Atomic WAL hand-off for a critical flush.
     *
     * P0 #1: before the insertMany we rename walPath → walProcessingPath
     * so concurrent writeToWal calls land on a fresh walPath instead of
     * the file we're about to delete. If insertMany succeeds we remove
     * walProcessingPath; if it fails we leave it for the next recovery.
     *
     * Returns whether a hand-off happened (so the caller can choose to
     * unlink on success).
     */
    private async beginWalHandoff(): Promise<boolean> {
        if (!this.walEnabled) return false;
        try {
            await fs.rename(this.walPath, this.walProcessingPath);
            return true;
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === 'ENOENT') return false; // nothing to hand off
            this.logger.warn({
                message: 'WAL hand-off rename failed; will retry on next flush',
                context: this.constructor.name,
                error: error as Error,
            });
            return false;
        }
    }

    /**
     * WAL: Clears file after successful flush.
     *
     * P0 #1: only removes the IN-FLIGHT file (walProcessingPath).
     * The live walPath that new spans are appending to is left
     * untouched — solves the prod race where unlinking the live WAL
     * dropped a span that arrived between insertMany success and
     * unlink call.
     */
    private async clearWal(): Promise<void> {
        if (!this.walEnabled) return;
        await this.unlinkSilently(this.walProcessingPath);
    }

    /**
     * P0 #1: when a critical flush fails, fold the in-flight WAL back
     * into the live one so subsequent flushes (or another boot) see
     * the data. The processing file is the snapshot of spans that
     * were in flight when insertMany failed; if we don't reabsorb it,
     * those spans only return on a *cold* boot after walRecovered
     * resets, which can be hours away during a healthy reconnect loop.
     */
    private async mergeWalProcessingBackIntoLive(): Promise<void> {
        if (!this.walEnabled) return;
        try {
            const processingContent = await fs.readFile(
                this.walProcessingPath,
                'utf8',
            );
            if (!processingContent.trim()) {
                await this.unlinkSilently(this.walProcessingPath);
                return;
            }
            // Append the processing content to whatever is in the live
            // WAL right now. Order: we prepend `processing` so older
            // spans stay first when recovery reads top-to-bottom; if
            // walPath has writes that happened during the failed
            // flush, those land *after* the recovered ones — preserves
            // chronological order.
            let liveContent = '';
            try {
                liveContent = await fs.readFile(this.walPath, 'utf8');
            } catch (readErr) {
                if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw readErr;
                }
            }
            const merged =
                processingContent +
                (liveContent.startsWith(EOL) || liveContent === ''
                    ? liveContent
                    : EOL + liveContent);
            await fs.writeFile(this.walPath, merged, 'utf8');
            await this.unlinkSilently(this.walProcessingPath);
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to merge in-flight WAL back; recovery will pick it up on next boot',
                context: this.constructor.name,
                error: error as Error,
            });
        }
    }

    /**
     * Rotate the DLQ file when it exceeds the configured cap.
     * Renames dlq.jsonl → dlq.jsonl.1, shifts older .N → .N+1, drops
     * anything beyond dlqMaxRotatedFiles. Without this the DLQ grows
     * unbounded during long outages and eventually fills the worker's
     * disk (P0 #2).
     */
    private async rotateDlqIfOversized(): Promise<void> {
        try {
            const stat = await fs.stat(this.dlqPath);
            if (stat.size <= this.dlqMaxBytes) return;
            // Shift dlq.jsonl.K → dlq.jsonl.(K+1), dropping the oldest.
            for (let i = this.dlqMaxRotatedFiles; i >= 1; i--) {
                const src = `${this.dlqPath}.${i}`;
                const dst = `${this.dlqPath}.${i + 1}`;
                if (i === this.dlqMaxRotatedFiles) {
                    await this.unlinkSilently(src);
                    continue;
                }
                try {
                    await fs.rename(src, dst);
                } catch (renameErr) {
                    if (
                        (renameErr as NodeJS.ErrnoException).code !== 'ENOENT'
                    ) {
                        throw renameErr;
                    }
                }
            }
            await fs.rename(this.dlqPath, `${this.dlqPath}.1`);
            this.logger.warn({
                message: 'DLQ rotated due to size cap',
                context: this.constructor.name,
                metadata: {
                    previousBytes: stat.size,
                    capBytes: this.dlqMaxBytes,
                },
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            this.logger.warn({
                message: 'DLQ rotation failed; will retry on next overflow',
                context: this.constructor.name,
                error: error as Error,
            });
        }
    }

    /**
     * DLQ: Writes overflow to Dead Letter Queue
     */
    private async writeToDeadLetterQueue(
        items: MongoDBTelemetryItem[],
    ): Promise<void> {
        try {
            await this.rotateDlqIfOversized();
            const lines =
                items.map((item) => JSON.stringify(item)).join(EOL) + EOL;
            await fs.appendFile(this.dlqPath, lines, 'utf8');

            this.logger.error({
                message:
                    '🚨 CRITICAL: Buffer overflow - spans moved to Dead Letter Queue',
                context: this.constructor.name,
                metadata: {
                    overflowCount: items.length,
                    dlqPath: this.dlqPath,
                    totalTokens: items.reduce(
                        (sum, item) =>
                            sum +
                            ((item.attributes?.[
                                GEN_AI.USAGE_TOTAL_TOKENS
                            ] as number) || 0),
                        0,
                    ),
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    '🚨🚨 CATASTROPHIC: Failed to write to DLQ - DATA LOST',
                context: this.constructor.name,
                error: error as Error,
                metadata: {
                    lostSpans: items.length,
                },
            });
        }
    }

    // --- ObservabilityExporter Implementation ---

    async exportTrace(item: TraceItemType): Promise<void> {
        this.exportTelemetry(item);
    }

    async shutdown(): Promise<void> {
        return this.dispose();
    }

    // --- End ObservabilityExporter Implementation ---

    async initialize(): Promise<void> {
        if (this.isInitialized) return;

        try {
            const { MongoClient: mongoClient } = await import('mongodb');

            this.client = new mongoClient(this.config.connectionString, {
                maxPoolSize: 20, // Aumentado para alto volume
                minPoolSize: 5, // Pool mínimo sempre ativo
                serverSelectionTimeoutMS: 3000, // Mais rápido
                connectTimeoutMS: 5000, // Timeout menor
                socketTimeoutMS: 30000, // Evita conexões travadas
                maxIdleTimeMS: 30000, // Limpa conexões idle
                retryWrites: true, // Retry automático em caso de falha
                retryReads: true, // Retry reads também
            });

            await this.client.connect();
            this.db = this.client.db(this.config.database);

            // Initializing collections
            this.collections = {
                logs: this.db.collection(this.config.collections.logs),
                telemetry: this.db.collection(
                    this.config.collections.telemetry,
                ),
            };

            // Ensure Time-Series collection exists (MongoDB 5.0+)
            await this.ensureTimeSeriesCollection(this.config.collections.logs);

            // Creating indexes for performance
            await this.createIndexes();

            // Setting up TTL for automatic cleanup
            await this.setupTTL();

            // Recovering critical spans from WAL (if exists)
            await this.recoverFromWal();

            // Starting flush timers
            this.startFlushTimers();

            this.isInitialized = true;

            this.logger.log({
                message: 'MongoDB Exporter initialized',
                context: this.constructor.name,
                metadata: {
                    database: this.config.database,
                    collections: this.config.collections,
                    batchSize: this.config.batchSize,
                    flushIntervalMs: this.config.flushIntervalMs,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to initialize MongoDB Exporter',
                context: this.constructor.name,
                error: error as Error,
            });
            throw error;
        }
    }

    /**
     * Ensure Time-Series collection is created with optimal settings
     */
    private async ensureTimeSeriesCollection(
        collectionName: string,
    ): Promise<void> {
        try {
            const collections = await this.db
                .listCollections({ name: collectionName })
                .toArray();
            if (collections.length === 0) {
                this.logger.log({
                    message: `Creating Time-Series collection: ${collectionName}`,
                    context: this.constructor.name,
                });

                const options: any = {
                    timeseries: {
                        timeField: 'timestamp',
                        metaField: 'metadata',
                        granularity: 'seconds',
                    },
                };

                // Only set TTL if configured (> 0)
                if (this.config.ttlDays && this.config.ttlDays > 0) {
                    options.expireAfterSeconds =
                        this.config.ttlDays * 24 * 60 * 60;
                } else {
                    this.logger.log({
                        message:
                            'Time-Series created with INFINITE retention (No TTL)',
                        context: this.constructor.name,
                    });
                }

                await this.db.createCollection(collectionName, options);
            }
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to ensure Time-Series collection (might already exist or not supported)',
                context: this.constructor.name,
                error: error as Error,
            });
        }
    }

    /**
     * Creating indexes for performance
     */
    private async createIndexes(): Promise<void> {
        if (!this.collections) {
            return;
        }

        try {
            // Logs indexes
            // Note: Time-Series automatically indexes 'timestamp' (clustered)
            // We only need secondary indexes for lookup patterns
            try {
                await this.collections.logs.createIndex({ correlationId: 1 });
                await this.collections.logs.createIndex({ level: 1 });

                // Dynamic Secondary Indexes (Configurable)
                // Defaults to standard SaaS pattern if not provided
                const defaultSecondaryIndexes = [
                    'metadata.component',
                    'metadata.tenantId',
                    'metadata.organizationId',
                    'metadata.teamId',
                ];

                const indexesToCreate =
                    this.config.secondaryIndexes || defaultSecondaryIndexes;

                for (const field of indexesToCreate) {
                    try {
                        await this.collections.logs.createIndex({ [field]: 1 });
                    } catch (idxError) {
                        this.logger.debug({
                            message: `Failed to create index for ${field}`,
                            context: this.constructor.name,
                            error: idxError as Error,
                        });
                    }
                }
            } catch {
                // Ignore general index creation errors
            }

            // Telemetry indexes
            await this.collections.telemetry.createIndex({ timestamp: 1 });
            await this.collections.telemetry.createIndex({ correlationId: 1 });
            await this.collections.telemetry.createIndex({ tenantId: 1 });
            await this.collections.telemetry.createIndex({ name: 1 });
            await this.collections.telemetry.createIndex({ agentName: 1 });
            await this.collections.telemetry.createIndex({ toolName: 1 });
            await this.collections.telemetry.createIndex({ phase: 1 });

            this.logger.log({
                message: 'Performance indexes created successfully',
                context: this.constructor.name,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to create performance indexes, continuing without indexes',
                context: this.constructor.name,
                error: error as Error,
            });
        }
    }

    /**
     * Setting up TTL for automatic cleanup
     */
    private async setupTTL(): Promise<void> {
        if (!this.collections) return;

        if (!this.config.ttlDays || this.config.ttlDays <= 0) {
            this.logger.log({
                message: 'TTL not configured, skipping TTL setup',
                context: this.constructor.name,
            });
            return;
        }

        const ttlSeconds = this.config.ttlDays * 24 * 60 * 60;

        try {
            const collections = [
                { name: 'logs', collection: this.collections.logs },
                { name: 'telemetry', collection: this.collections.telemetry },
            ];

            for (const { name, collection } of collections) {
                try {
                    const existingIndexes = await collection
                        .listIndexes()
                        .toArray();
                    const ttlIndexExists = existingIndexes.some(
                        (index: any) =>
                            index.key.createdAt === 1 &&
                            index.expireAfterSeconds,
                    );

                    if (!ttlIndexExists) {
                        try {
                            await collection.dropIndex('createdAt_1');
                            this.logger.log({
                                message: `Dropped existing createdAt index without TTL for ${name}`,
                                context: this.constructor.name,
                            });
                        } catch {
                            this.logger.debug({
                                message: `Could not drop existing createdAt index for ${name}, continuing`,
                                context: this.constructor.name,
                            });
                        }

                        await collection.createIndex(
                            { createdAt: 1 },
                            {
                                expireAfterSeconds: ttlSeconds,
                                background: true,
                            },
                        );
                        this.logger.log({
                            message: `Created TTL index for ${name} collection`,
                            context: this.constructor.name,
                        });
                    } else {
                        this.logger.debug({
                            message: `TTL index already exists for ${name} collection`,
                            context: this.constructor.name,
                        });
                    }
                } catch (collectionError) {
                    this.logger.warn({
                        message: `Failed to setup TTL for ${name} collection`,
                        context: this.constructor.name,
                        error: collectionError as Error,
                    });
                }
            }
        } catch (error) {
            this.logger.warn({
                message: 'Failed to create TTL indexes, continuing without TTL',
                context: this.constructor.name,
                error: error as Error,
                metadata: {
                    ttlDays: this.config.ttlDays,
                },
            });
        }
    }

    /**
     * Iniciar timers de flush
     */
    private startFlushTimers(): void {
        if (this.logFlushTimer || this.telemetryFlushTimer) {
            return;
        }

        this.logFlushTimer = setInterval(
            () => this.flushLogs(),
            this.config.flushIntervalMs,
        );

        this.telemetryFlushTimer = setInterval(
            () => this.flushTelemetry(),
            this.config.flushIntervalMs,
        );

        // Health check a cada 30s
        this.healthCheckTimer = setInterval(() => this.checkHealth(), 30000);
    }

    /**
     * Monitor automatic health: Check alerts and log warnings
     */
    private checkHealth(): void {
        const metrics = this.getMetrics();

        if (metrics.alerts.circuitOpen) {
            this.logger.warn({
                message:
                    '⚠️ ALERT: Circuit breaker is OPEN - MongoDB unavailable',
                context: this.constructor.name,
                metadata: {
                    failureCount: metrics.failureCount,
                    criticalBuffered: metrics.criticalTelemetryBuffered,
                },
            });
        }

        if (metrics.alerts.criticalBufferCritical) {
            this.logger.error({
                message:
                    '🚨 ALERT: Critical buffer at 95% capacity - Data loss imminent!',
                context: this.constructor.name,
                metadata: {
                    criticalBuffered: metrics.criticalTelemetryBuffered,
                    maxSize: this.maxCriticalBufferSize,
                    percentage:
                        (metrics.criticalTelemetryBuffered /
                            this.maxCriticalBufferSize) *
                        100,
                },
            });
        } else if (metrics.alerts.criticalBufferHigh) {
            this.logger.warn({
                message:
                    '⚠️ ALERT: Critical buffer at 80% capacity - Action needed',
                context: this.constructor.name,
                metadata: {
                    criticalBuffered: metrics.criticalTelemetryBuffered,
                    maxSize: this.maxCriticalBufferSize,
                },
            });
        }

        if (metrics.alerts.multipleFailures && !metrics.alerts.circuitOpen) {
            this.logger.warn({
                message:
                    '⚠️ ALERT: Multiple MongoDB failures detected - Circuit may open soon',
                context: this.constructor.name,
                metadata: {
                    failureCount: metrics.failureCount,
                    threshold: this.failureThreshold,
                },
            });
        }
    }

    /**
     * Export log
     */
    async exportLog(
        level: LogLevel,
        message: string,
        context?: LogContext | string,
        error?: Error,
        legacyError?: Error,
    ): Promise<void> {
        let component = 'unknown';
        let metadata: LogContext | undefined;
        const actualError = error || legacyError;

        if (typeof context === 'string') {
            component = context;
            metadata = undefined;
        } else if (typeof context === 'object') {
            component = String(context?.component || 'unknown');
            metadata = context;
        }

        this._pushLog(level, message, component, metadata, actualError);
    }

    private _pushLog(
        level: LogLevel,
        message: string,
        component: string,
        context?: LogContext,
        error?: Error,
    ) {
        // MongoDB saves all logs for complete history/audit trail
        // Console logging respects API_LOG_LEVEL via Pino
        // Prevent buffer overflow
        if (this.logBuffer.length >= this.maxBufferSize) {
            // Drop oldest logs to make space for new ones
            const droppedCount = this.logBuffer.length - this.maxBufferSize + 1;
            this.logBuffer.splice(0, droppedCount);
            // Optionally log internally that we dropped logs, but be careful not to loop
        }

        // Extract and normalize critical fields for Bucketing (Configurable)
        // Defaults to basic fields if no bucket keys provided
        const bucketKeys = this.config.bucketKeys || [
            'component',
            'level',
            'tenantId',
        ];

        // Normalize context for bucketing (e.g. flatten organizationAndTeamData)
        const normalizedContext: Record<string, any> = {
            ...(context || {}),
        };
        const orgTeam = (context as any)?.organizationAndTeamData;
        if (orgTeam && typeof orgTeam === 'object') {
            if (!normalizedContext.organizationId && orgTeam.organizationId) {
                normalizedContext.organizationId = orgTeam.organizationId;
            }
            if (!normalizedContext.teamId && orgTeam.teamId) {
                normalizedContext.teamId = orgTeam.teamId;
            }
            if (!normalizedContext.tenantId && orgTeam.tenantId) {
                normalizedContext.tenantId = orgTeam.tenantId;
            }
        }

        // Metadata: Only contains Low-Cardinality fields for grouping
        const metadata: Record<string, any> = {
            component,
            level,
        };

        // Attributes: Contains high-cardinality details (Payload)
        const attributes = {
            ...normalizedContext,
            originalCorrelationId: normalizedContext?.correlationId,
        };

        // Extract configured bucket keys from context
        for (const key of bucketKeys) {
            // Skip already set basic fields
            if (key === 'component' || key === 'level') continue;

            const value = normalizedContext?.[key];
            if (value) {
                metadata[key] = value;
            } else {
                // Critical for Time-Series performance: Avoid null buckets
                metadata[key] = 'unknown';
            }
        }

        // Ensure correlationId always exists (Index Key)
        const correlationId =
            (normalizedContext?.correlationId as string) || randomUUID();

        // Ensure tenantId exists in metadata (common requirement)
        if (!metadata.tenantId) {
            metadata.tenantId =
                (normalizedContext?.tenantId as string) || 'unknown';
        }

        // Callers frequently pass shapes with circular refs (Axios errors
        // with config↔request↔response, Mongoose documents, Error.cause
        // loops). Without sanitizing, BSON serialization in `insertMany`
        // throws "Cannot convert circular structure to BSON" and the
        // entire batch is dropped. We run `deepSanitize` over the WHOLE
        // logItem (not just metadata/attributes) so cycles in any field —
        // including `error.message` from atypical Error subclasses and
        // top-level identifiers like `executionId`/`correlationId` that
        // callers may accidentally hand in as objects — get replaced with
        // '[Circular]' before they reach the buffer.
        const rawLogItem: MongoDBLogItem = {
            timestamp: new Date(),
            level,
            message,
            component,
            correlationId, // Guaranteed UUID
            tenantId: metadata.tenantId,
            executionId: normalizedContext?.executionId as string | undefined,
            sessionId: normalizedContext?.sessionId as string | undefined,
            metadata, // Clean bucket key — sanitized below as part of logItem
            attributes, // Detailed payload (schema-less) — sanitized below
            error: error
                ? {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                  }
                : undefined,
            createdAt: new Date(),
        } as any; // Cast necessary due to dynamic 'attributes' field injection

        const logItem = deepSanitize(rawLogItem) as MongoDBLogItem;

        this.logBuffer.push(logItem);

        if (this.logBuffer.length >= this.config.batchSize) {
            void this.flushLogs();
        }
    }

    process(
        level: LogLevel,
        message: string,
        context?: LogContext,
        error?: Error,
    ): void {
        void this.exportLog(level, message, context, error);
    }

    exportTelemetry(item: TraceItem): void {
        const duration = item.endTime - item.startTime;
        const correlationId =
            (item.attributes[AGENT.CORRELATION_ID] as string) ||
            (item.attributes[TOOL.CORRELATION_ID] as string) ||
            (item.attributes['correlationId'] as string);
        const tenantId =
            (item.attributes[AGENT.TENANT_ID] as string) ||
            (item.attributes['tenantId'] as string) ||
            (item.attributes['tenant.id'] as string);
        const executionId =
            (item.attributes[AGENT.EXECUTION_ID] as string) ||
            (item.attributes[TOOL.EXECUTION_ID] as string) ||
            (item.attributes['execution.id'] as string);
        const sessionId =
            (item.attributes[AGENT.CONVERSATION_ID] as string) ||
            (item.attributes['sessionId'] as string) ||
            (item.attributes['conversation.id'] as string);
        const agentName = item.attributes[AGENT.NAME] as string;
        const toolName = item.attributes[TOOL.NAME] as string;
        const phase = item.attributes['agent.phase'] as
            | 'think'
            | 'act'
            | 'observe';

        const telemetryItem: MongoDBTelemetryItem = {
            timestamp: new Date(item.startTime),
            name: item.name,
            duration,
            correlationId,
            tenantId,
            executionId,
            sessionId,
            agentName,
            toolName,
            phase,
            // Same circular-ref / BSON-safety guard as exportLog — span
            // attributes can carry rich payloads (LLM input/output, MCP
            // tool args) that occasionally contain self-references.
            attributes: deepSanitize(item.attributes),
            status: item.status.code as any,
            error: item.status.message
                ? {
                      name: 'Error',
                      message: item.status.message,
                  }
                : undefined,
            createdAt: new Date(),
        };

        // Dual Buffer: Crítico (LLM) vs Normal
        const isCritical = this.isCriticalSpan(telemetryItem);

        if (isCritical) {
            // Span crítico (LLM = billing): NUNCA descarta + WAL
            this.criticalTelemetryBuffer.push(telemetryItem);

            // WAL: Persiste localmente (async, não bloqueia)
            void this.writeToWal(telemetryItem);

            // Critical buffer hard cap: Move overflow para DLQ
            if (
                this.criticalTelemetryBuffer.length >=
                this.maxCriticalBufferSize
            ) {
                // Remove os 1000 mais antigos para DLQ
                const overflowCount = Math.min(
                    1000,
                    this.criticalTelemetryBuffer.length -
                        this.maxCriticalBufferSize +
                        1000,
                );
                const overflow = this.criticalTelemetryBuffer.splice(
                    0,
                    overflowCount,
                );

                // Escreve no DLQ (async, não bloqueia)
                void this.writeToDeadLetterQueue(overflow);
            }
        } else {
            // Span normal: Buffer menor, pode descartar se necessário
            this.normalTelemetryBuffer.push(telemetryItem);

            // Prevent buffer overflow (apenas para normal)
            if (this.normalTelemetryBuffer.length >= this.maxBufferSize) {
                const droppedCount =
                    this.normalTelemetryBuffer.length - this.maxBufferSize + 1;
                this.normalTelemetryBuffer.splice(0, droppedCount);
                this.logger.warn({
                    message:
                        'Normal telemetry buffer overflow, dropping old items',
                    context: this.constructor.name,
                    metadata: { droppedCount },
                });
            }
        }

        // Trigger flush if either buffer reaches batch size
        const totalTelemetry =
            this.criticalTelemetryBuffer.length +
            this.normalTelemetryBuffer.length;
        if (totalTelemetry >= this.config.batchSize) {
            void this.flushTelemetry();
        }
    }

    async exportError(error: Error, context?: LogContext): Promise<void> {
        const logContext = {
            ...context,
            component: 'error-handler',
        };
        await this.exportLog('error', error.message, logContext, error);
    }

    /**
     * Drop items that cannot be serialized to BSON (circular refs,
     * BigInt, throwing getters, etc.). One bad item would otherwise
     * poison the entire `insertMany` batch and the catch block would
     * re-buffer all of them, producing the runaway error loop documented
     * in https://github.com/kodustech/kodus-ai/issues/1106.
     *
     * Returns the survivors and the count of dropped items so callers
     * can log a single rolled-up warning instead of one error per item.
     */
    private screenForBson<T>(items: T[]): {
        sanitized: T[];
        droppedCount: number;
    } {
        const sanitized: T[] = [];
        let droppedCount = 0;
        for (const item of items) {
            try {
                JSON.stringify(item);
                sanitized.push(item);
            } catch {
                droppedCount++;
            }
        }
        return { sanitized, droppedCount };
    }

    /**
     * Given a failed `insertMany` (with `ordered: false`) and the
     * original batch, return ONLY the items the server did not commit.
     *
     * Driver behavior we rely on (mongodb ^7.2.0):
     *   - On partial success the driver throws `MongoBulkWriteError`
     *     with `.result.insertedIds` (a `{ [index]: ObjectId }` map of
     *     items that did get inserted) and `.writeErrors[]` (entries
     *     for each failed item, each with `.index`).
     *   - On a pre-flight failure (e.g. BSON serialization), `.result`
     *     and `.writeErrors` are absent — assume nothing committed.
     *
     * We strip `_id` from the items we hand back so the retry path can
     * let MongoDB generate fresh ids server-side. Reusing the original
     * client-side `_id` after a partial commit was the root cause of
     * the E11000 storms in issue #1106.
     */
    private extractRebufferable<T extends { _id?: unknown }>(
        error: unknown,
        originalBatch: T[],
    ): T[] {
        const insertedIndices = new Set<number>();
        const err = error as {
            result?: { insertedIds?: Record<string, unknown> };
            insertedIds?: Record<string, unknown>;
            writeErrors?: Array<{ index?: number }>;
        };
        const insertedIds =
            err?.result?.insertedIds ?? err?.insertedIds ?? null;
        if (insertedIds && typeof insertedIds === 'object') {
            for (const key of Object.keys(insertedIds)) {
                const idx = Number(key);
                if (Number.isFinite(idx)) insertedIndices.add(idx);
            }
        }
        const knownFailedIndices = new Set<number>();
        if (Array.isArray(err?.writeErrors)) {
            for (const we of err.writeErrors) {
                if (typeof we?.index === 'number') {
                    knownFailedIndices.add(we.index);
                }
            }
        }

        // If we got no signal at all (e.g. BSON pre-flight throw),
        // assume the whole batch needs retrying.
        const haveSignal =
            insertedIndices.size > 0 || knownFailedIndices.size > 0;

        const survivors: T[] = [];
        originalBatch.forEach((item, idx) => {
            if (insertedIndices.has(idx)) {
                return;
            } // already committed
            if (haveSignal && !knownFailedIndices.has(idx)) {
                // Unclear status: with explicit signal present but this
                // index not marked failed, treat as "may have committed
                // partially" and drop to be safe — protects against the
                // E11000 loop in the original report.
                return;
            }
            // Strip the client-side _id so the next insertMany asks
            // Mongo to generate a fresh one. Preserves the rest of the
            // document shape. Done via clone + delete (not a
            // destructuring rename) to satisfy the project's naming
            // rule that bans underscore-prefixed locals.
            const rest = { ...item } as T & { _id?: unknown };
            delete rest._id;
            survivors.push(rest as unknown as T);
        });
        return survivors;
    }

    /**
     * Flush logs para MongoDB
     */
    private async flushLogs(): Promise<void> {
        if (this.logBuffer.length === 0 || this.isFlushingLogs) {
            return;
        }
        if (!this.collections) {
            void this.scheduleReconnect('flushLogs');
            return;
        }

        this.isFlushingLogs = true;
        const logsToFlush = [...this.logBuffer];
        this.logBuffer = [];

        // Pre-screen every log for serialization readiness. Logs that
        // can't even round-trip through JSON.stringify — cycles missed
        // by deepSanitize (BigInt, getters that throw, Symbol-keyed
        // payloads) — would poison the whole insertMany batch at BSON
        // time AND get re-pushed onto the buffer by the catch block
        // below, forming the loop responsible for 24.7k consecutive
        // "Failed to flush logs to MongoDB" errors observed in prod.
        // Dropping the offenders here keeps the healthy majority on
        // the happy path.
        const { sanitized: sanitizedLogs, droppedCount: poisonedCount } =
            this.screenForBson(logsToFlush);
        if (poisonedCount > 0) {
            this.logger.warn({
                message: `Dropping ${poisonedCount} non-serializable log entr${poisonedCount === 1 ? 'y' : 'ies'} from flush batch (would have poisoned insertMany)`,
                context: this.constructor.name,
                metadata: {
                    droppedCount: poisonedCount,
                    batchSize: logsToFlush.length,
                },
            });
        }

        if (sanitizedLogs.length === 0) {
            this.isFlushingLogs = false;
            return;
        }

        // PERFORMANCE OPTIMIZATION: Sort by Bucket Keys before inserting.
        // This drastically improves Time-Series compression and write throughput.
        const bucketKeys = this.config.bucketKeys || [
            'organizationId',
            'teamId',
        ];

        sanitizedLogs.sort((a, b) => {
            for (const key of bucketKeys) {
                const valA = (a.metadata as any)?.[key] || '';
                const valB = (b.metadata as any)?.[key] || '';
                if (valA !== valB) {
                    return String(valA).localeCompare(String(valB));
                }
            }
            return 0;
        });

        try {
            // ordered: false so a single bad doc doesn't stop the rest
            // from committing, and so the BulkWriteError carries the
            // full list of which indices made it in vs which didn't —
            // we use that in `extractRebufferable` to avoid the E11000
            // loop that happens when items are re-buffered with the
            // same client-side `_id` after a partial commit.
            await this.collections.logs.insertMany(sanitizedLogs, {
                ordered: false,
            });
            // Removed debug log to avoid recursive logging and pollution
        } catch (error) {
            this.logger.error({
                message: 'Failed to flush logs to MongoDB',
                context: this.constructor.name,
                error: error as Error,
            });

            await this.handleConnectionError(error as Error, 'flushLogs');

            // Re-buffer only the items the server did NOT commit, with
            // their client-side `_id` stripped so the retry path lets
            // Mongo generate fresh ids. Respect max buffer size; keep
            // the most recent entries if capacity forces us to drop.
            const toRetry = this.extractRebufferable(error, sanitizedLogs);
            const availableSpace = this.maxBufferSize - this.logBuffer.length;
            if (availableSpace > 0 && toRetry.length > 0) {
                const toKeep = toRetry.slice(
                    Math.max(0, toRetry.length - availableSpace),
                );
                this.logBuffer.unshift(...toKeep);
            }

            // Exponential Backoff logic could be applied by pausing the timer, but here we just rely on interval.
            // A more sophisticated approach would be to dynamically adjust flushIntervalMs, but simplest is just logging and retrying next tick.
        } finally {
            this.isFlushingLogs = false;
        }
    }

    /**
     * Circuit Breaker: Check if we should allow the operation
     */
    private canExecute(): boolean {
        const now = Date.now();

        // If circuit is open, check if we should try half-open
        if (this.circuitBreakerState === 'open') {
            if (now - this.lastFailureTime >= this.resetTimeout) {
                this.circuitBreakerState = 'half-open';
                this.logger.warn({
                    message: 'Circuit breaker entering half-open state',
                    context: this.constructor.name,
                });
                return true;
            }
            return false; // Circuit still open
        }

        return true; // Closed or half-open, allow execution
    }

    /**
     * Circuit Breaker: Record a successful operation
     */
    private recordSuccess(): void {
        if (this.circuitBreakerState === 'half-open') {
            this.successCount++;
            if (this.successCount >= 2) {
                // After 2 successes in half-open, close the circuit
                this.circuitBreakerState = 'closed';
                this.failureCount = 0;
                this.successCount = 0;
                this.logger.log({
                    message: 'Circuit breaker closed - MongoDB healthy',
                    context: this.constructor.name,
                });
            }
        } else if (this.circuitBreakerState === 'closed') {
            // Reset failure count on success
            this.failureCount = 0;
        }
    }

    /**
     * Circuit Breaker: Record a failed operation
     */
    private recordFailure(): void {
        this.lastFailureTime = Date.now();
        this.failureCount++;
        this.successCount = 0;

        if (
            this.failureCount >= this.failureThreshold &&
            this.circuitBreakerState !== 'open'
        ) {
            this.circuitBreakerState = 'open';
            this.logger.error({
                message: '🚨 Circuit breaker OPENED - MongoDB unavailable',
                context: this.constructor.name,
                metadata: {
                    failureCount: this.failureCount,
                    threshold: this.failureThreshold,
                    resetTimeout: this.resetTimeout,
                },
            });
        }
    }

    /**
     * Flush telemetry para MongoDB (Dual Buffer: Crítico + Normal)
     */
    private async flushTelemetry(): Promise<void> {
        if (
            this.criticalTelemetryBuffer.length === 0 &&
            this.normalTelemetryBuffer.length === 0
        ) {
            return;
        }

        if (this.isFlushingTelemetry) return;

        // Circuit Breaker: Skip normal spans if circuit is open, but try critical anyway
        const circuitOpen = !this.canExecute();

        if (!this.collections) {
            this.recordFailure();
            void this.scheduleReconnect('flushTelemetry');
            return;
        }

        this.isFlushingTelemetry = true;

        // P0 #5: outer try/finally guarantees the flag is released even
        // if `screenForBson`, `logger.warn`, or any code outside the
        // inner try blocks throws. Without this, a stuck `true` would
        // make every subsequent flushTelemetry tick a silent no-op and
        // the buffer would grow until overflow.
        try {
            // 1️⃣ CRITICAL SPANS (LLM = Billing)
            // P0 #4: when the circuit is open, even critical was hammering
            // Mongo every interval — once per failureThreshold * intervalMs
            // we'd log "🚨 CRITICAL: Failed to flush LLM spans" again,
            // dominating the error feed the exact same way issue #1106 did.
            // Now when the circuit is open we LEAVE the critical buffer
            // intact (WAL already protects against process loss) and only
            // log a rolled-up warning. The half-open transition in
            // `canExecute()` continues normally, and the next try happens
            // after `resetTimeout`.
            if (circuitOpen && this.criticalTelemetryBuffer.length > 0) {
                this.logger.warn({
                    message:
                        'Circuit breaker OPEN - holding critical spans in buffer + WAL',
                    context: this.constructor.name,
                    metadata: {
                        criticalBufferSize: this.criticalTelemetryBuffer.length,
                    },
                });
            }
            if (!circuitOpen && this.criticalTelemetryBuffer.length > 0) {
                const criticalRaw = [...this.criticalTelemetryBuffer];
                this.criticalTelemetryBuffer = [];

                // Pre-screen mirrors flushLogs: drop spans that can't be
                // serialized so a single bad payload doesn't poison the
                // whole batch at BSON time and trigger the runaway re-buffer
                // loop documented in issue #1106.
                const {
                    sanitized: criticalToFlush,
                    droppedCount: criticalDropped,
                } = this.screenForBson(criticalRaw);
                if (criticalDropped > 0) {
                    this.logger.warn({
                        message: `Dropping ${criticalDropped} non-serializable critical telemetry item${criticalDropped === 1 ? '' : 's'} from flush batch`,
                        context: this.constructor.name,
                        metadata: {
                            droppedCount: criticalDropped,
                            batchSize: criticalRaw.length,
                        },
                    });
                }

                if (criticalToFlush.length > 0) {
                    // P0 #1: atomic WAL hand-off. Move the live WAL aside
                    // BEFORE insertMany so any writeToWal that fires while
                    // the network request is in flight lands on a fresh
                    // walPath. We only unlink the in-flight file on success.
                    const handedOff = await this.beginWalHandoff();
                    try {
                        await this.collections.telemetry.insertMany(
                            criticalToFlush,
                            { ordered: false },
                        );
                        this.recordSuccess();

                        // P0 #1: success → remove only the IN-FLIGHT WAL
                        // file. The live walPath, possibly containing
                        // spans that arrived during the insertMany call,
                        // is left alone to be flushed in the next tick.
                        if (handedOff) {
                            await this.clearWal();
                        }

                        this.logger.log({
                            message: `Flushed ${criticalToFlush.length} critical LLM spans`,
                            context: this.constructor.name,
                        });
                    } catch (error) {
                        this.recordFailure();

                        this.logger.error({
                            message:
                                '🚨 CRITICAL: Failed to flush LLM spans - DATA IN WAL',
                            context: this.constructor.name,
                            error: error as Error,
                            metadata: {
                                lostSpans: criticalToFlush.length,
                                totalTokens: criticalToFlush.reduce(
                                    (sum, item) =>
                                        sum +
                                        (item.attributes?.[
                                            GEN_AI.USAGE_TOTAL_TOKENS
                                        ] as number),
                                    0,
                                ),
                            },
                        });

                        await this.handleConnectionError(
                            error as Error,
                            'flushTelemetry',
                        );

                        // Re-buffer ONLY items the server didn't commit.
                        // `_id` is stripped so retry asks Mongo to generate
                        // a fresh id — kills the E11000 loop from issue
                        // #1106. Critical spans are never dropped on full
                        // success; here partial commits drop the committed
                        // half (intentionally — they're already persisted).
                        const toRetry = this.extractRebufferable(
                            error,
                            criticalToFlush,
                        );
                        if (toRetry.length > 0) {
                            this.criticalTelemetryBuffer.unshift(...toRetry);
                        }

                        // P0 #1: failed flush → fold the in-flight WAL back
                        // into the live one so subsequent flushes (or a
                        // future boot before walRecovered flips) see it.
                        // Without this merge the walProcessingPath becomes
                        // an orphan that only the next process boot would
                        // recover.
                        if (handedOff) {
                            await this.mergeWalProcessingBackIntoLive();
                        }
                    }
                }
            }

            // 2️⃣ NORMAL SPANS - Only flush if circuit closed
            if (
                !circuitOpen &&
                this.normalTelemetryBuffer.length > 0 &&
                this.collections
            ) {
                const normalRaw = [...this.normalTelemetryBuffer];
                this.normalTelemetryBuffer = [];

                // Same pre-screen as critical / logs — see issue #1106.
                const {
                    sanitized: normalToFlush,
                    droppedCount: normalDropped,
                } = this.screenForBson(normalRaw);
                if (normalDropped > 0) {
                    this.logger.warn({
                        message: `Dropping ${normalDropped} non-serializable normal telemetry item${normalDropped === 1 ? '' : 's'} from flush batch`,
                        context: this.constructor.name,
                        metadata: {
                            droppedCount: normalDropped,
                            batchSize: normalRaw.length,
                        },
                    });
                }

                if (normalToFlush.length > 0) {
                    try {
                        await this.collections.telemetry.insertMany(
                            normalToFlush,
                            {
                                ordered: false,
                            },
                        );
                        this.recordSuccess();
                    } catch (error) {
                        this.recordFailure();

                        this.logger.warn({
                            message:
                                'Failed to flush normal telemetry to MongoDB',
                            context: this.constructor.name,
                            error: error as Error,
                        });

                        await this.handleConnectionError(
                            error as Error,
                            'flushTelemetry',
                        );

                        // Re-buffer only uncommitted items, stripping `_id`
                        // to avoid the E11000 retry loop from issue #1106.
                        // Respect the buffer cap.
                        const toRetry = this.extractRebufferable(
                            error,
                            normalToFlush,
                        );
                        const availableSpace =
                            this.maxBufferSize -
                            this.normalTelemetryBuffer.length;
                        if (availableSpace > 0 && toRetry.length > 0) {
                            const toKeep = toRetry.slice(
                                Math.max(0, toRetry.length - availableSpace),
                            );
                            this.normalTelemetryBuffer.unshift(...toKeep);
                        }
                    }
                }
            } else if (circuitOpen && this.normalTelemetryBuffer.length > 0) {
                this.logger.warn({
                    message:
                        'Circuit breaker OPEN - skipping normal telemetry flush',
                    context: this.constructor.name,
                    metadata: {
                        normalBufferSize: this.normalTelemetryBuffer.length,
                    },
                });
            }
        } finally {
            this.isFlushingTelemetry = false;
        }
    }

    /**
     * Flush todos os buffers
     */
    async flush(): Promise<void> {
        await Promise.allSettled([this.flushLogs(), this.flushTelemetry()]);
    }

    /**
     * Dispose do exporter com graceful shutdown
     */
    async dispose(): Promise<void> {
        this.logger.log({
            message: 'Graceful shutdown initiated',
            context: this.constructor.name,
            metadata: {
                pendingLogs: this.logBuffer.length,
                pendingCriticalTelemetry: this.criticalTelemetryBuffer.length,
                pendingNormalTelemetry: this.normalTelemetryBuffer.length,
                circuitState: this.circuitBreakerState,
            },
        });

        // Stop accepting new data
        if (this.logFlushTimer) clearInterval(this.logFlushTimer);
        if (this.telemetryFlushTimer) clearInterval(this.telemetryFlushTimer);
        if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);

        // Temporarily force circuit closed to allow final flush
        const originalCircuitState = this.circuitBreakerState;
        this.circuitBreakerState = 'closed';

        // Flush all pending data with timeout
        try {
            await Promise.race([
                this.flush(),
                new Promise((_, reject) =>
                    setTimeout(
                        () =>
                            reject(new Error('Flush timeout during shutdown')),
                        10000,
                    ),
                ),
            ]);
            this.logger.log({
                message: 'All buffers flushed successfully during shutdown',
                context: this.constructor.name,
            });
        } catch (error) {
            this.logger.error({
                message:
                    '🚨 CRITICAL: Failed to flush buffers during shutdown - DATA MAY BE LOST',
                context: this.constructor.name,
                error: error as Error,
                metadata: {
                    lostLogs: this.logBuffer.length,
                    lostCriticalTelemetry: this.criticalTelemetryBuffer.length,
                    lostNormalTelemetry: this.normalTelemetryBuffer.length,
                },
            });
        } finally {
            this.circuitBreakerState = originalCircuitState;
        }

        // Close MongoDB connection
        if (this.client) {
            try {
                await this.client.close();
            } catch (error) {
                this.logger.error({
                    message: 'Error closing MongoDB connection',
                    context: this.constructor.name,
                    error: error as Error,
                });
            }
        }

        this.collections = null;
        this.db = null;
        this.client = null;
        this.isInitialized = false;
        this.reconnectInProgress = false;

        this.logger.log({
            message: 'Graceful shutdown completed',
            context: this.constructor.name,
        });
    }

    /**
     * Get health status of the exporter
     */
    getHealthStatus(): {
        healthy: boolean;
        initialized: boolean;
        circuitState: string;
        bufferStats: {
            logs: number;
            criticalTelemetry: number;
            normalTelemetry: number;
            totalTelemetry: number;
            logsPercentage: number;
            criticalTelemetryPercentage: number;
            normalTelemetryPercentage: number;
        };
        connectionStats: {
            connected: boolean;
            failureCount: number;
            lastFailureTime: number;
        };
    } {
        const totalTelemetry =
            this.criticalTelemetryBuffer.length +
            this.normalTelemetryBuffer.length;

        return {
            healthy:
                this.isInitialized &&
                this.circuitBreakerState !== 'open' &&
                !!this.collections,
            initialized: this.isInitialized,
            circuitState: this.circuitBreakerState,
            bufferStats: {
                logs: this.logBuffer.length,
                criticalTelemetry: this.criticalTelemetryBuffer.length,
                normalTelemetry: this.normalTelemetryBuffer.length,
                totalTelemetry,
                logsPercentage:
                    (this.logBuffer.length / this.maxBufferSize) * 100,
                criticalTelemetryPercentage:
                    (this.criticalTelemetryBuffer.length /
                        this.maxCriticalBufferSize) *
                    100,
                normalTelemetryPercentage:
                    (this.normalTelemetryBuffer.length / this.maxBufferSize) *
                    100,
            },
            connectionStats: {
                connected: !!this.client && !!this.collections,
                failureCount: this.failureCount,
                lastFailureTime: this.lastFailureTime,
            },
        };
    }

    /**
     * Get metrics for monitoring
     */
    getMetrics(): {
        totalLogsBuffered: number;
        criticalTelemetryBuffered: number;
        normalTelemetryBuffered: number;
        totalTelemetryBuffered: number;
        circuitState: string;
        failureCount: number;
        isHealthy: boolean;
        alerts: {
            circuitOpen: boolean;
            criticalBufferHigh: boolean;
            criticalBufferCritical: boolean;
            normalBufferHigh: boolean;
            multipleFailures: boolean;
        };
    } {
        const health = this.getHealthStatus();
        const criticalBufferUsage =
            this.criticalTelemetryBuffer.length / this.maxCriticalBufferSize;
        const normalBufferUsage =
            this.normalTelemetryBuffer.length / this.maxBufferSize;

        return {
            totalLogsBuffered: health.bufferStats.logs,
            criticalTelemetryBuffered: health.bufferStats.criticalTelemetry,
            normalTelemetryBuffered: health.bufferStats.normalTelemetry,
            totalTelemetryBuffered: health.bufferStats.totalTelemetry,
            circuitState: health.circuitState,
            failureCount: health.connectionStats.failureCount,
            isHealthy: health.healthy,
            alerts: {
                circuitOpen: this.circuitBreakerState === 'open',
                criticalBufferHigh: criticalBufferUsage > 0.8, // >80%
                criticalBufferCritical: criticalBufferUsage > 0.95, // >95%
                normalBufferHigh: normalBufferUsage > 0.8,
                multipleFailures: this.failureCount >= 3,
            },
        };
    }

    private isConnectionError(error: Error): boolean {
        const message = error?.message ?? '';
        return (
            error?.name === 'MongoNotConnectedError' ||
            error?.name === 'MongoNetworkError' ||
            message.includes('Client must be connected') ||
            message.includes('Topology is closed')
        );
    }

    private async handleConnectionError(
        error: Error,
        operation: string,
    ): Promise<void> {
        if (!this.isConnectionError(error)) return;

        this.logger.warn({
            message: `MongoDB connection lost during ${operation}, scheduling reconnect`,
            context: this.constructor.name,
            error,
        });

        await this.resetConnection();
        void this.scheduleReconnect(operation);
    }

    private async resetConnection(): Promise<void> {
        this.collections = null;
        this.db = null;
        this.isInitialized = false;

        if (this.client) {
            try {
                await this.client.close();
            } catch {
                // Ignore close errors when resetting.
            }
        }

        this.client = null;
    }

    private async scheduleReconnect(operation: string): Promise<void> {
        if (this.reconnectInProgress) return;

        const now = Date.now();
        if (now - this.lastReconnectAt < this.reconnectDelayMs) return;

        this.reconnectInProgress = true;
        this.lastReconnectAt = now;

        try {
            await this.initialize();
        } catch (error) {
            this.logger.warn({
                message: `MongoDB reconnect attempt failed during ${operation}`,
                context: this.constructor.name,
                error: error as Error,
            });
        } finally {
            this.reconnectInProgress = false;
        }
    }
}

export function createMongoDBExporterFromStorage(
    storageConfig: ObservabilityStorageConfig,
): MongoDBExporter {
    const config: Partial<MongoDBExporterConfig> = {
        connectionString: storageConfig.connectionString,
        database: storageConfig.database,
        collections: {
            logs: storageConfig.collections?.logs || 'observability_logs_ts',
            telemetry:
                storageConfig.collections?.telemetry ||
                'observability_telemetry',
        },
        batchSize: storageConfig.batchSize || 100,
        flushIntervalMs: storageConfig.flushIntervalMs || 5000,
        maxRetries: 3,
        ttlDays: storageConfig.ttlDays ?? 0,
        enableObservability: storageConfig.enableObservability ?? true,
        secondaryIndexes: storageConfig.secondaryIndexes,
        bucketKeys: storageConfig.bucketKeys,
    };

    return new MongoDBExporter(config);
}

export function createMongoDBExporter(
    config?: Partial<MongoDBExporterConfig>,
): MongoDBExporter {
    return new MongoDBExporter(config);
}
