import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { SendKodyRulesAutoPauseDigestUseCase } from '@libs/cockpit/application/use-cases/send-kody-rules-auto-pause-digest.use-case';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';

const LOCK_KEY = 'CRON:KODY_RULES:AUTO_PAUSE_DIGEST';
const LOCK_TTL_MS = 30 * 60 * 1000;

/**
 * Weekly email to org admins listing the Kody Rules auto-paused since the
 * last one. Organizations with nothing new get no email.
 *
 * Schedule: `0 9 * * 1` (Mondays 09:00 UTC) by default. Override via
 * `API_CRON_KODY_RULES_AUTO_PAUSE_DIGEST`.
 */
@Injectable()
export class KodyRulesAutoPauseDigestCron {
    private readonly logger = new Logger(KodyRulesAutoPauseDigestCron.name);

    constructor(
        private readonly useCase: SendKodyRulesAutoPauseDigestUseCase,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(process.env.API_CRON_KODY_RULES_AUTO_PAUSE_DIGEST || '0 9 * * 1', {
        name: 'kody-rules-auto-pause-digest',
        timeZone: 'UTC',
    })
    async handle(): Promise<void> {
        const lock = await this.distributedLockService
            .acquire(LOCK_KEY, { ttl: LOCK_TTL_MS })
            .catch((err: unknown) => {
                this.logger.warn(
                    `kody rules auto-pause digest lock acquire threw: ${err instanceof Error ? err.message : String(err)}`,
                );
                return null;
            });
        if (!lock) {
            this.logger.log(
                'skipping kody rules auto-pause digest — another replica holds the lock',
            );
            return;
        }

        const start = Date.now();
        try {
            const result = await this.useCase.execute(new Date());
            this.logger.log(
                `kody rules auto-pause digest done in ${Date.now() - start}ms — ${JSON.stringify(result)}`,
            );
        } catch (err) {
            this.logger.error(
                `kody rules auto-pause digest failed: ${err instanceof Error ? err.message : String(err)}`,
                err instanceof Error ? err.stack : undefined,
            );
        } finally {
            await lock.release().catch((err: unknown) => {
                this.logger.warn(
                    `kody rules auto-pause digest lock release failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            });
        }
    }
}
