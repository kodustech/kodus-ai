import { createLogger } from '@libs/core/log/logger';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import {
    CheckConclusion,
    CheckStatus,
} from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

const API_CRON_STALE_REVIEW_WATCHDOG =
    process.env.API_CRON_STALE_REVIEW_WATCHDOG || '*/10 * * * *';

// Must sit above every legitimate recovery window: the job-level abort
// timeout (105min, job-processor-router.service.ts) and the inbox claim
// timeout (150min) after which a crashed worker's message is redelivered.
// Anything IN_PROGRESS beyond this is unrecoverable — the process that
// owned it died without a terminal update.
const STALE_REVIEW_TIMEOUT_MINUTES = 180;

// PR reviews heartbeat `updatedAt` every 60s while their process is alive
// (automationCodeReview.ts startExecutionHeartbeat), so 15 quiet minutes
// means the owner is gone even though the job and inbox windows above are
// still open. A message redelivered after such a death opens a new
// execution row, so reaping this one early does not race the retry.
// CLI reviews do not heartbeat and stay on the long fallback.
const STALE_HEARTBEAT_TIMEOUT_MINUTES = 15;
const NON_HEARTBEAT_ORIGINS = ['cli'];

const BATCH_SIZE = 100;

const STALE_ERROR_MESSAGE =
    'Code review interrupted — the review process stopped unexpectedly (e.g. service restart) and did not complete. Push a new commit or start a new review to retry.';

/**
 * Reaps automation executions stuck in IN_PROGRESS. The review pipeline
 * runs in memory; a hard crash (OOM, SIGKILL, deploy) skips every catch/
 * finally, leaving the execution row IN_PROGRESS forever and the platform
 * check run (persisted in dataExecution.checkRun by the pipeline observer)
 * spinning "in progress" on the PR indefinitely.
 */
@Injectable()
export class StaleReviewWatchdogCronProvider {
    private readonly logger = createLogger(
        StaleReviewWatchdogCronProvider.name,
    );

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        private readonly checksAdapterFactory: ChecksAdapterFactory,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    @Cron(API_CRON_STALE_REVIEW_WATCHDOG, {
        name: 'STALE REVIEW WATCHDOG',
        timeZone: 'America/Sao_Paulo',
        waitForCompletion: true,
    })
    async handleCron(): Promise<void> {
        const lock = await this.acquireCronLock();

        if (!lock) {
            return;
        }

        try {
            const now = Date.now();
            const cutoffDate = new Date(
                now - STALE_REVIEW_TIMEOUT_MINUTES * 60 * 1000,
            );
            const heartbeatCutoffDate = new Date(
                now - STALE_HEARTBEAT_TIMEOUT_MINUTES * 60 * 1000,
            );

            const [heartbeatStale, fallbackStale] = await Promise.all([
                this.automationExecutionService.findStaleInProgress(
                    heartbeatCutoffDate,
                    BATCH_SIZE,
                    { excludeOrigins: NON_HEARTBEAT_ORIGINS },
                ),
                this.automationExecutionService.findStaleInProgress(
                    cutoffDate,
                    BATCH_SIZE,
                ),
            ]);

            const staleExecutions = [
                ...new Map(
                    [...(heartbeatStale ?? []), ...(fallbackStale ?? [])].map(
                        (execution) => [execution.uuid, execution],
                    ),
                ).values(),
            ];

            if (!staleExecutions?.length) {
                return;
            }

            this.logger.log({
                message: `Found ${staleExecutions.length} stale in-progress code review executions`,
                context: StaleReviewWatchdogCronProvider.name,
                metadata: {
                    cutoffDate,
                    heartbeatCutoffDate,
                    staleTimeoutMinutes: STALE_REVIEW_TIMEOUT_MINUTES,
                    staleHeartbeatTimeoutMinutes:
                        STALE_HEARTBEAT_TIMEOUT_MINUTES,
                },
            });

            for (const execution of staleExecutions) {
                await this.reapExecution(execution);
            }
        } catch (error) {
            this.logger.error({
                message: 'Stale review watchdog run failed',
                context: StaleReviewWatchdogCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await this.releaseCronLock(lock);
        }
    }

    private async reapExecution(
        execution: AutomationExecutionEntity,
    ): Promise<void> {
        try {
            // Close stage logs the dead process left IN_PROGRESS (agent
            // steps etc.) so the PR executions UI stops showing them as
            // running with a live elapsed timer.
            const closedStages =
                await this.automationExecutionService.finalizeInProgressStageLogs(
                    execution.uuid,
                    AutomationStatus.ERROR,
                    STALE_ERROR_MESSAGE,
                );

            await this.automationExecutionService.updateCodeReview(
                { uuid: execution.uuid },
                {
                    status: AutomationStatus.ERROR,
                    errorMessage: STALE_ERROR_MESSAGE,
                },
                STALE_ERROR_MESSAGE,
                'Kody Review Finished',
            );

            const checkFinalized = await this.finalizeOrphanedCheck(execution);

            this.logger.log({
                message: `Reaped stale code review execution ${execution.uuid}`,
                context: StaleReviewWatchdogCronProvider.name,
                metadata: {
                    executionUuid: execution.uuid,
                    pullRequestNumber: execution.pullRequestNumber,
                    repositoryId: execution.repositoryId,
                    stuckSince: execution.updatedAt,
                    checkFinalized,
                    closedStages,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `Failed to reap stale execution ${execution.uuid}`,
                context: StaleReviewWatchdogCronProvider.name,
                error: error instanceof Error ? error : undefined,
                metadata: { executionUuid: execution.uuid },
            });
        }
    }

    private async finalizeOrphanedCheck(
        execution: AutomationExecutionEntity,
    ): Promise<boolean> {
        const dataExecution = execution.dataExecution || {};
        const checkRun = dataExecution.checkRun;
        const platformType = dataExecution.platformType as PlatformType;
        const organizationAndTeamData = dataExecution.organizationAndTeamData;

        if (
            !checkRun?.id ||
            !checkRun?.repository?.owner ||
            !checkRun?.repository?.name ||
            !platformType ||
            !organizationAndTeamData
        ) {
            return false;
        }

        const adapter = this.checksAdapterFactory.getAdapter(platformType);

        return adapter.updateCheckRun({
            checkRunId: checkRun.id,
            organizationAndTeamData,
            repository: checkRun.repository,
            status: CheckStatus.COMPLETED,
            conclusion: CheckConclusion.FAILURE,
            output: {
                title: 'Code Review Interrupted',
                summary: STALE_ERROR_MESSAGE,
            },
        });
    }

    private async acquireCronLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:STALE_REVIEW_WATCHDOG',
                { ttl: 10 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire stale review watchdog lock',
                context: StaleReviewWatchdogCronProvider.name,
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
                message: 'Failed to release stale review watchdog lock',
                context: StaleReviewWatchdogCronProvider.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}
