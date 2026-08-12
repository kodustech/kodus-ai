import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PullRequestClassifierService } from '@libs/ee/analytics-warehouse';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

const LOCK_KEY = 'CRON:ANALYTICS_CLASSIFIER';
// 25min TTL for a 30min-tick cron. Auto-clears on crashes without
// letting a runaway hold the slot into the next tick.
const LOCK_TTL_MS = 25 * 60 * 1000;

/**
 * Cron wrapper that drives `PullRequestClassifierService` on a schedule.
 * Classifies unclassified PRs via LLM and fills `analytics.pull_request_types`
 * so bug-ratio and other "by type" aggregates have ground truth.
 *
 * Tunable via `ANALYTICS_CLASSIFIER_CRON` (standard cron expression).
 * Default = every 30 minutes. Disable with `ANALYTICS_CLASSIFIER_DISABLED=true`.
 *
 * Concurrency: 15 worker replicas in prod. Without a distributed lock
 * every replica would call the LLM on the same unclassified rows every
 * 30min — the upserts are idempotent so the DB stays correct, but the
 * OpenAI spend multiplies by 15. Local `running` mutex still catches
 * same-node reentry.
 */
@Injectable()
export class AnalyticsClassifierCron {
    private readonly logger = new Logger(AnalyticsClassifierCron.name);
    private running = false;

    constructor(
        private readonly classifier: PullRequestClassifierService,
        private readonly distributedLockService: DistributedLockService,
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

        const lock = await this.distributedLockService
            .acquire(LOCK_KEY, { ttl: LOCK_TTL_MS })
            .catch((err: unknown) => {
                this.logger.warn(
                    `analytics classifier lock acquire threw: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
            });

        if (!lock) {
            this.logger.log(
                'skipping analytics classifier — another replica holds the lock',
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
            await lock.release().catch((err: unknown) => {
                this.logger.warn(
                    `analytics classifier lock release failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }
    }
}
