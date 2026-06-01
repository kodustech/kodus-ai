import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PullRequestIngestionService } from '@libs/ee/analytics-warehouse';

/**
 * Cron wrapper that drives `PullRequestIngestionService` on a schedule.
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
export class AnalyticsIngestionCron {
    private readonly logger = new Logger(AnalyticsIngestionCron.name);
    private running = false;

    constructor(
        private readonly ingestion: PullRequestIngestionService,
    ) {}

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
        if (process.env.ANALYTICS_INGESTION_DISABLED === 'true') {
            return;
        }
        if (this.running) {
            this.logger.warn(
                'skipping analytics ingestion — previous run still in flight',
            );
            return;
        }

        this.running = true;
        const start = Date.now();
        try {
            const res = await this.ingestion.run();
            this.logger.log(
                `analytics ingestion done in ${Date.now() - start}ms — ${JSON.stringify(res)}`,
            );
        } catch (err) {
            this.logger.error(
                `analytics ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            this.running = false;
        }
    }
}
