import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
    FeedbackIngestionService,
    PullRequestIngestionService,
    ReviewOperationalIngestionService,
} from '@libs/ee/analytics-warehouse';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

const LOCK_KEY = 'CRON:ANALYTICS_INGESTION';
// 25min — the run typically takes 5–15min; the tick is every 30min so
// this covers the slowest observed pass while still auto-clearing if
// a worker crashes mid-run.
const LOCK_TTL_MS = 25 * 60 * 1000;

/**
 * Cron wrapper that drives cockpit warehouse ingestion on a schedule.
 * Interval is tunable via `ANALYTICS_INGESTION_CRON` (standard cron
 * expression). Default = every 30 minutes.
 *
 * Concurrency: the worker deployment runs 15 replicas in prod
 * (`worker_desired_count = 15`), so an in-process `running` mutex is
 * not enough — without a distributed lock every replica would run the
 * warehouse ingestion (LLM calls + DELETE/INSERT children in tx per
 * batch) simultaneously every 30min. That produces 15× the OpenAI
 * spend on classification + burns warehouse write capacity for no
 * benefit. The local `running` flag is still kept as a cheap short-
 * circuit against reentry on the same node (e.g. the boot spawn
 * overlapping the first cron tick).
 */
@Injectable()
export class AnalyticsIngestionCron implements OnApplicationBootstrap {
    private readonly logger = new Logger(AnalyticsIngestionCron.name);
    private running = false;

    constructor(
        private readonly ingestion: PullRequestIngestionService,
        private readonly feedbackIngestion: FeedbackIngestionService,
        private readonly reviewOperationalIngestion: ReviewOperationalIngestionService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    onApplicationBootstrap(): void {
        if (
            process.env.ANALYTICS_INGESTION_DISABLED === 'true' ||
            process.env.ANALYTICS_INGESTION_RUN_ON_BOOT === 'false'
        ) {
            return;
        }

        setImmediate(() => {
            void this.runAll('startup');
        });
    }

    // `??` only swaps null/undefined — but docker-compose sets the var
    // as an empty string when unset (`${VAR:-}`), which would slip
    // through and crash the cron lib with "Too few fields". Use `||` so
    // empty strings also fall back to the default.
    @Cron(
        process.env.ANALYTICS_INGESTION_CRON ||
            CronExpression.EVERY_30_MINUTES,
        { name: 'analytics-ingestion' },
    )
    async handle(): Promise<void> {
        await this.runAll('cron');
    }

    private async runAll(trigger: 'cron' | 'startup'): Promise<void> {
        if (process.env.ANALYTICS_INGESTION_DISABLED === 'true') {
            return;
        }
        if (this.running) {
            this.logger.warn(
                `skipping analytics ingestion (${trigger}) — previous run still in flight`,
            );
            return;
        }

        // Cross-replica gate: only one worker across the fleet runs.
        const lock = await this.distributedLockService
            .acquire(LOCK_KEY, { ttl: LOCK_TTL_MS })
            .catch((err: unknown) => {
                this.logger.warn(
                    `analytics ingestion (${trigger}) lock acquire threw: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
            });

        if (!lock) {
            this.logger.log(
                `skipping analytics ingestion (${trigger}) — another replica holds the lock`,
            );
            return;
        }

        this.running = true;
        const start = Date.now();
        try {
            try {
                const res = await this.ingestion.run();
                this.logger.log(
                    `analytics ingestion (${trigger}) done in ${Date.now() - start}ms — ${JSON.stringify(res)}`,
                );
            } catch (err) {
                this.logger.error(
                    `analytics ingestion (${trigger}) failed: ${err instanceof Error ? err.message : String(err)}`,
                    err instanceof Error ? err.stack : undefined,
                );
            }

            // Feedback is a much lighter pass (flat docs, no children);
            // run it on the same tick so both stay equally fresh. Its
            // failure must not mask a successful PR ingestion above.
            try {
                const fb = await this.feedbackIngestion.run();
                this.logger.log(
                    `feedback ingestion done — ${JSON.stringify(fb)}`,
                );
            } catch (fbErr) {
                this.logger.error(
                    `feedback ingestion failed: ${fbErr instanceof Error ? fbErr.message : String(fbErr)}`,
                    fbErr instanceof Error ? fbErr.stack : undefined,
                );
            }

            try {
                const ops = await this.reviewOperationalIngestion.run();
                this.logger.log(
                    `review operational ingestion done — ${JSON.stringify(ops)}`,
                );
            } catch (opsErr) {
                this.logger.error(
                    `review operational ingestion failed: ${opsErr instanceof Error ? opsErr.message : String(opsErr)}`,
                    opsErr instanceof Error ? opsErr.stack : undefined,
                );
            }
        } finally {
            this.running = false;
            await lock.release().catch((err: unknown) => {
                this.logger.warn(
                    `analytics ingestion lock release failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }
    }
}
