import { createLogger } from '@kodus/flow';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { SSOTestSessionService } from '@libs/ee/sso/services/sso-test-session.service';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

const API_CRON_SSO_TEST_SESSION_CLEANUP =
    process.env.API_CRON_SSO_TEST_SESSION_CLEANUP || '0 1 * * *';

@Injectable()
export class SSOTestSessionCleanupCronProvider {
    private readonly logger = createLogger(
        SSOTestSessionCleanupCronProvider.name,
    );

    constructor(
        private readonly ssoTestSessionService: SSOTestSessionService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_SSO_TEST_SESSION_CLEANUP, {
        name: 'SSO Test Session Cleanup',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();

        if (!lock) {
            return;
        }

        try {
            const deletedCount =
                await this.ssoTestSessionService.cleanupExpiredSessions();

            if (deletedCount > 0) {
                this.logger.log({
                    message: 'Expired SSO test sessions cleaned up',
                    context: SSOTestSessionCleanupCronProvider.name,
                    metadata: { deletedCount },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to cleanup expired SSO test sessions',
                context: SSOTestSessionCleanupCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:SSO:TEST_SESSION_CLEANUP',
                { ttl: 9 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire SSO test session cleanup lock',
                context: SSOTestSessionCleanupCronProvider.name,
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
                message: 'Failed to release SSO test session cleanup lock',
                context: SSOTestSessionCleanupCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
