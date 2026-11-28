import { Injectable } from '@nestjs/common';

import { GatedCron } from '@libs/core/infrastructure/services/cron-run-gate';
import { createLogger } from '@libs/core/log/logger';
import { type DistributedLock, DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

import { RuntimeDefaultBranchPushSetup } from '../application/default-branch-push-setup.service';
import { RUNTIME_CRON_SCHEDULES } from './runtime-cron-schedules';

/** Environments drained per tick; the rest wait for the next one. */
const PER_TICK = 50;

/**
 * Asks for the setup a default-branch push held back while another setup of the environment ran (every 2 minutes by
 * default, RUNTIME_CRON_PUSH_SETUP_DRAIN). One product-worker replica at a time; the ledger's atomic claim alone keeps
 * a commit from being taken twice when two run anyway.
 */
@Injectable()
export class RuntimePushSetupCron {
    private readonly logger = createLogger(RuntimePushSetupCron.name);

    constructor(
        private readonly pushSetup: RuntimeDefaultBranchPushSetup,
        private readonly locks: DistributedLockService,
    ) {}

    @GatedCron(RUNTIME_CRON_SCHEDULES.pushSetupDrain, { name: 'Runtime push setup drain' })
    async handleCron(): Promise<void> {
        let lock: DistributedLock | null = null;
        try {
            lock = await this.locks.acquire('CRON:RUNTIME:PUSH_SETUP_DRAIN', { ttl: 5 * 60 * 1000 });
            if (!lock) return;
            const summary = await this.pushSetup.drain(PER_TICK);
            if (summary.pending) this.logger.log({ message: 'Runtime push setup: drain', context: RuntimePushSetupCron.name, metadata: { ...summary } });
        } catch (error) {
            this.logger.error({ message: 'Runtime push setup: drain failed', context: RuntimePushSetupCron.name, error: error instanceof Error ? error : undefined });
        } finally {
            if (lock) await lock.release().catch(() => undefined);
        }
    }
}
