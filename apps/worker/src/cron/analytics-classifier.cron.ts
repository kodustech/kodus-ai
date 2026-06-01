import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PullRequestClassifierService } from '@libs/ee/analytics-warehouse';

/**
 * Cron wrapper that drives `PullRequestClassifierService` on a schedule.
 * Classifies unclassified PRs via LLM and fills `analytics.pull_request_types`
 * so bug-ratio and other "by type" aggregates have ground truth.
 *
 * Tunable via `ANALYTICS_CLASSIFIER_CRON` (standard cron expression).
 * Default = every 15 minutes. Disable with `ANALYTICS_CLASSIFIER_DISABLED=true`.
 *
 * Concurrency: same in-memory mutex trick as `AnalyticsIngestionCron`.
 * Two ticks overlapping would mostly be wasted work (both picking the
 * same unclassified rows) — the upserts are idempotent but the LLM
 * cost would double.
 */
@Injectable()
export class AnalyticsClassifierCron {
    private readonly logger = new Logger(AnalyticsClassifierCron.name);
    private running = false;

    constructor(
        private readonly classifier: PullRequestClassifierService,
    ) {}

    // `||` so that docker-compose's `${VAR:-}` empty-string fallthrough
    // hits the default instead of crashing the cron lib.
    @Cron(
        process.env.ANALYTICS_CLASSIFIER_CRON ||
            CronExpression.EVERY_30_MINUTES,
        { name: 'analytics-classifier' },
    )
    async handle(): Promise<void> {
        if (process.env.ANALYTICS_CLASSIFIER_DISABLED === 'true') {
            return;
        }
        if (this.running) {
            this.logger.warn(
                'skipping analytics classifier — previous run still in flight',
            );
            return;
        }

        this.running = true;
        const start = Date.now();
        try {
            const res = await this.classifier.run();
            if (res.scanned > 0) {
                this.logger.log(
                    `analytics classifier done in ${Date.now() - start}ms — ${JSON.stringify(res)}`,
                );
            }
        } catch (err) {
            this.logger.error(
                `analytics classifier failed: ${err instanceof Error ? err.message : String(err)}`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            this.running = false;
        }
    }
}
