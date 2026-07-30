import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import {
    FeedbackIngestionService,
    PullRequestIngestionService,
    ReviewOperationalIngestionService,
} from '@libs/ee/analytics-warehouse';

/**
 * Cron wrapper that drives cockpit warehouse ingestion on a schedule.
 * Interval is tunable via `ANALYTICS_INGESTION_CRON` (standard cron
 * expression). Default = every 15 minutes.
 *
 * Concurrency: a second instance landing while one is still running
 * would cause transaction contention, not correctness issues — UPSERTs
 * and the per-PR DELETE/INSERT children run inside a single tx per
 * batch, and the watermark is idempotent. We keep a local in-memory
 * guard as a cheap mutex so we don't stack up runs on a single node.
 */
@Injectable()
export class AnalyticsIngestionCron implements OnApplicationBootstrap {
    private readonly logger = new Logger(AnalyticsIngestionCron.name);
    private running = false;

    constructor(
        private readonly ingestion: PullRequestIngestionService,
        private readonly feedbackIngestion: FeedbackIngestionService,
        private readonly reviewOperationalIngestion: ReviewOperationalIngestionService,
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
        }
    }
}
