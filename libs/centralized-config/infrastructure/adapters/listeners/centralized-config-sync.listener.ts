import { createLogger } from '@libs/core/log/logger';
import { CentralizedConfigSyncUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-sync.use-case';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    CENTRALIZED_CONFIG_SERVICE_TOKEN,
    ICentralizedConfigService,
} from '@libs/centralized-config/domain/contracts/CentralizedConfigService.contract';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

// Sync involves ~15 GitHub calls + ~45 pg queries for a monorepo with
// centralized config enabled. 5min covers the largest observed run;
// TTL exists so a crashed handler doesn't leave the lock stuck.
const CENTRALIZED_SYNC_LOCK_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class CentralizedConfigSyncListener {
    private readonly logger = createLogger(CentralizedConfigSyncListener.name);

    constructor(
        private readonly centralizedConfigSyncUseCase: CentralizedConfigSyncUseCase,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
        @Inject(CENTRALIZED_CONFIG_SERVICE_TOKEN)
        private readonly centralizedConfigService: ICentralizedConfigService,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @OnEvent('pull-request.closed')
    async handlePullRequestClosedEvent(event: PullRequestClosedEvent) {
        if (!event.repository || !event.repository.id) {
            this.logger.warn({
                message:
                    'Received pull-request.closed event without repository information, skipping centralized config sync',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        const validation =
            await this.centralizedConfigService.validateCentralizedConfig({
                organizationAndTeamData: event.organizationAndTeamData,
                repository: event.repository,
            });

        if (!validation.success) {
            this.logger.log({
                message:
                    'Centralized config not enabled or validation failed, skipping sync',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    organizationAndTeamData: event.organizationAndTeamData,
                    message: validation.message,
                },
            });
            return;
        }

        this.logger.log({
            message:
                'Handling pull-request.closed event for centralized config sync',
            context: CentralizedConfigSyncListener.name,
            metadata: {
                repositoryId: event.repository?.id,
                repositoryName: event.repository?.name,
                pullRequestNumber: event.pullRequestNumber,
            },
        });

        const closeHandlingResult =
            await this.centralizedConfigPrService.handleTrackedPullRequestClose(
                {
                    organizationAndTeamData: event.organizationAndTeamData,
                    repository: event.repository,
                    pullRequestNumber: event.pullRequestNumber,
                    merged: event.merged,
                },
            );

        if (!closeHandlingResult.shouldSync) {
            this.logger.log({
                message:
                    'Centralized pull request closed without merge, skipping centralized sync',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    repositoryId: event.repository?.id,
                    pullRequestNumber: event.pullRequestNumber,
                },
            });

            return;
        }

        // Cross-process idempotency via pg_try_advisory_lock. The
        // pull-request.closed event reaches every process hosting this
        // listener (API + worker, plus CrossProcessEventsBridge re-emit)
        // — without a shared claim, each replica runs the ~45 pg + 15
        // GitHub call sync pipeline for the same merge. First acquirer
        // wins; the others get null and skip. Same pattern used by
        // KodyRulesSyncListener.
        const lockKey = `CENTRALIZED_CONFIG:SYNC:${event.organizationAndTeamData?.organizationId}:${event.repository.id}:${event.pullRequestNumber}`;
        const lock = await this.distributedLockService.acquire(lockKey, {
            ttl: CENTRALIZED_SYNC_LOCK_TTL_MS,
        });

        if (!lock) {
            this.logger.log({
                message:
                    'Centralized sync already claimed by another process for this merge — skipping duplicate run',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    lockKey,
                    pullRequestNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        try {
            await this.centralizedConfigSyncUseCase.execute({
                organizationAndTeamData: event.organizationAndTeamData,
                repository: event.repository,
            });
        } finally {
            await lock.release();
        }
    }
}
