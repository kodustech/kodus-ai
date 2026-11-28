import { Injectable } from '@nestjs/common';
import { GatedCron } from '@libs/core/infrastructure/services/cron-run-gate';
import { RUNTIME_CRON_SCHEDULES } from './runtime-cron-schedules';

import { createLogger } from '@libs/core/log/logger';
import { kodyRuntimeEnabledInThisProcess } from '@libs/runtime-publish/runtime-feature';
import { type DistributedLock, DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { RuntimePullRequestSessionSweep } from '../application/use-cases/pull-request-session-sweep.use-case';

// Every 30 minutes: a lost PR close is caught at most STALE_SESSION_HOURS + 30 min after the session.

/** Runs the PR session sweep on one API replica at a time. */
@Injectable()
export class RuntimePullRequestSessionSweepCron {
    private readonly logger = createLogger(RuntimePullRequestSessionSweepCron.name);

    constructor(
        private readonly sweep: RuntimePullRequestSessionSweep,
        private readonly locks: DistributedLockService,
    ) {}

    @GatedCron(RUNTIME_CRON_SCHEDULES.prSessionSweep, { name: 'Runtime PR session sweep' })
    async handleCron(): Promise<void> {
        // The API imports the Runtime everywhere; a deployment without it sweeps nothing.
        if (!kodyRuntimeEnabledInThisProcess()) return;
        let lock: DistributedLock | null = null;
        try {
            lock = await this.locks.acquire('CRON:RUNTIME:PR_SESSION_SWEEP', { ttl: 25 * 60 * 1000 });
            if (!lock) return;
            await this.sweep.run();
        } catch (error) {
            this.logger.error({ message: 'Runtime PR session sweep failed', context: RuntimePullRequestSessionSweepCron.name, error: error instanceof Error ? error : undefined });
        } finally {
            // DistributedLock.release logs its own failure, and the TTL frees the lock anyway.
            if (lock) await lock.release().catch(() => undefined);
        }
    }
}
