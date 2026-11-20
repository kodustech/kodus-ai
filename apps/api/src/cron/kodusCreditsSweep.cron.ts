import pLimit from 'p-limit';

import {
    GatedCron,
    cronRunGate,
} from '@libs/core/infrastructure/services/cron-run-gate';
import { createLogger } from '@libs/core/log/logger';
import {
    KODUS_CREDITS_METERING_SERVICE_TOKEN,
    KodusCreditsMeteringService,
} from '@libs/analytics/application/credits/kodus-credits-metering.service';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { Injectable, Inject } from '@nestjs/common';

const API_CRON_KODUS_CREDITS_SWEEP =
    process.env.API_CRON_KODUS_CREDITS_SWEEP || '*/5 * * * *';

// Each organization's sweep scans its new telemetry spans and writes its
// charges; this many at a time keeps those scans from stacking on the primary.
const SWEEP_CONCURRENCY = 4;

// A run starts no organization after this, inside the 5-minute schedule; the
// ones left are swept by the next tick (the sweep is idempotent: unique span
// ids on both sides).
const SWEEP_RUN_BUDGET_MS = 4 * 60 * 1000;

// The lock outlives a run: the budget plus room for the sweeps already
// started to finish, so the next tick never stacks a second sweep on the same
// scans. A crashed process frees it at once (a Postgres advisory lock on the
// run's own session); a run that hangs holds it for two ticks at most.
const SWEEP_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Every 5 minutes: journal Kodus-routed usage spans as charges and debit them
 * from each org's prepaid balance. Single-flight across workers via the
 * distributed lock (the sweep is idempotent anyway — unique span ids on both
 * sides — but two concurrent sweeps would just waste billing calls).
 */
@Injectable()
export class KodusCreditsSweepCronProvider {
    private readonly logger = createLogger(KodusCreditsSweepCronProvider.name);

    constructor(
        @Inject(KODUS_CREDITS_METERING_SERVICE_TOKEN)
        private readonly metering: KodusCreditsMeteringService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @GatedCron(API_CRON_KODUS_CREDITS_SWEEP, {
        name: 'Kodus Credits Sweep',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();
        if (!lock) {
            return;
        }

        try {
            const orgs =
                await this.metering.listOrganizationsWithKodusCredential();
            if (orgs.length === 0) {
                return;
            }

            const limit = pLimit(SWEEP_CONCURRENCY);
            const startedAt = Date.now();
            const deadline = startedAt + SWEEP_RUN_BUDGET_MS;
            // Each run starts at a random organization of the sorted list, so
            // the ones a run defers are as likely as any to lead the next: an
            // organization waits about N/K runs (K swept per run), with no
            // state kept between runs. Sorted, so its place does not hang on
            // the order the read returns them in.
            const sorted = [...orgs].sort();
            const offset = Math.floor(Math.random() * sorted.length);
            const ordered = [
                ...sorted.slice(offset),
                ...sorted.slice(0, offset),
            ];
            let started = 0;
            const results = await Promise.allSettled(
                ordered.map((organizationId) =>
                    limit(async () => {
                        // Past the budget, or shutting down: the next tick
                        // (or the next process) sweeps it.
                        if (cronRunGate.stopping || Date.now() >= deadline) {
                            return null;
                        }
                        started += 1;
                        return this.metering.sweepOrganization(organizationId);
                    }),
                ),
            );

            const failed = results.filter((r) => r.status === 'rejected');
            const summaries = results
                .filter((r) => r.status === 'fulfilled')
                .map((r) => (r as PromiseFulfilledResult<any>).value)
                .filter(Boolean);
            const debited = summaries.reduce((s, x) => s + (x.debited ?? 0), 0);
            const debitedUsd = summaries.reduce(
                (s, x) => s + (x.debitedUsd ?? 0),
                0,
            );

            this.logger.log({
                message: 'Kodus credits sweep completed',
                context: KodusCreditsSweepCronProvider.name,
                metadata: {
                    orgs: orgs.length,
                    deferred: orgs.length - started,
                    failed: failed.length,
                    debited,
                    debitedUsd: Math.round(debitedUsd * 1e6) / 1e6,
                },
            });
            if (failed.length > 0) {
                this.logger.error({
                    message: 'Some Kodus credits sweeps failed',
                    context: KodusCreditsSweepCronProvider.name,
                    metadata: { failed: failed.length, total: orgs.length },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Kodus credits sweep cron failed',
                context: KodusCreditsSweepCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:KODUS_CREDITS:SWEEP',
                { ttl: SWEEP_LOCK_TTL_MS },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire Kodus credits sweep lock',
                context: KodusCreditsSweepCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseCronLock(lock: DistributedLock | null): Promise<void> {
        if (!lock) {
            return;
        }
        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: 'Failed to release Kodus credits sweep lock',
                context: KodusCreditsSweepCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
