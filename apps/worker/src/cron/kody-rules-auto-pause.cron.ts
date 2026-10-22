import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { AutoPauseKodyRulesUseCase } from '@libs/cockpit/application/use-cases/auto-pause-kody-rules.use-case';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

const LOCK_KEY = 'CRON:KODY_RULES:AUTO_PAUSE';
const LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Daily pass that pauses the Kody Rules Cockpit labels ignored or noisy, for
 * organizations with `kodyRulesAutoPauseEnabled` on.
 *
 * Schedule: `0 6 * * *` (06:00 UTC) by default. Override via
 * `API_CRON_KODY_RULES_AUTO_PAUSE`; set to a never-firing expression to
 * disable. Lives in the analytics role: installs without it never run it.
 */
@Injectable()
export class KodyRulesAutoPauseCron {
    private readonly logger = new Logger(KodyRulesAutoPauseCron.name);

    constructor(
        private readonly useCase: AutoPauseKodyRulesUseCase,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(process.env.API_CRON_KODY_RULES_AUTO_PAUSE || '0 6 * * *', {
        name: 'kody-rules-auto-pause',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        const lock = await this.distributedLockService
            .acquire(LOCK_KEY, { ttl: LOCK_TTL_MS })
            .catch((err: unknown) => {
                this.logger.warn(
                    `kody rules auto-pause lock acquire threw: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
            });
        if (!lock) {
            this.logger.log(
                'skipping kody rules auto-pause — another replica holds the lock',
            );
            return;
        }

        const start = Date.now();
        try {
            const result = await this.useCase.execute(new Date());
            this.logger.log(
                `kody rules auto-pause done in ${Date.now() - start}ms — ${JSON.stringify(result)}`,
            );
        } catch (err) {
            this.logger.error(
                `kody rules auto-pause failed: ${err instanceof Error ? err.message : String(err)}`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            await lock.release().catch((err: unknown) => {
                this.logger.warn(
                    `kody rules auto-pause lock release failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }
    }
}
