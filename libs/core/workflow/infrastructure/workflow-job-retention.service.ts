import { BeforeApplicationShutdown, Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { sleep } from '@libs/common/utils/helpers';
import { CronRunGate } from '@libs/core/infrastructure/services/cron-run-gate';
import { createLogger } from '@libs/core/log/logger';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';

import {
    DistributedLock,
    DistributedLockService,
} from './distributed-lock.service';

/** Finished jobs are kept this long after their last update. */
export const WORKFLOW_JOB_RETENTION_DAYS = 30;
/**
 * Small batches keep each DELETE short (a few ms per batch when the FK
 * indexes exist) and leave I/O headroom on the shared instance.
 */
export const WORKFLOW_JOB_RETENTION_BATCH_SIZE = 2000;
const PAUSE_BETWEEN_BATCHES_MS = 500;
/** A run stops here; the next day picks up where it left off. */
const RUN_BUDGET_MS = 30 * 60 * 1000;

/**
 * Deletes finished workflow jobs older than WORKFLOW_JOB_RETENTION_DAYS.
 *
 * workflow_jobs was never cleaned (issue #2582). Nothing reads job history past a few days: the
 * self-hosted doctor looks at the last 7. Deleting stops the table from
 * growing once autovacuum makes the space reusable; it does not hand disk
 * back to the operating system.
 */
@Injectable()
export class WorkflowJobRetentionService implements BeforeApplicationShutdown {
    private readonly logger = createLogger(WorkflowJobRetentionService.name);
    private readonly runGate = new CronRunGate();

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    // 06:00 UTC: night in the Americas, before the European morning.
    @Cron('0 6 * * *', { name: 'workflow-job-retention' })
    async purgeFinishedJobs(): Promise<void> {
        await this.runGate.run(() => this.purge());
    }

    beforeApplicationShutdown(): Promise<void> {
        return this.runGate.stop();
    }

    private async purge(): Promise<void> {
        const lock = await this.acquireLock();
        if (!lock) {
            return;
        }

        try {
            const result = await this.run({
                olderThan: new Date(
                    Date.now() -
                        WORKFLOW_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
                ),
                budgetMs: RUN_BUDGET_MS,
                pauseMs: PAUSE_BETWEEN_BATCHES_MS,
            });

            this.logger.log({
                message: 'Workflow job retention run finished',
                context: WorkflowJobRetentionService.name,
                metadata: {
                    ...result,
                    retentionDays: WORKFLOW_JOB_RETENTION_DAYS,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Workflow job retention run failed',
                context: WorkflowJobRetentionService.name,
                error: error instanceof Error ? error : undefined,
            });
        } finally {
            await lock.release().catch(() => undefined);
        }
    }

    /**
     * Deletes batch after batch until one comes back short (nothing older
     * is left) or the time budget runs out.
     */
    async run(params: {
        olderThan: Date;
        budgetMs: number;
        pauseMs: number;
        now?: () => number;
        sleep?: (ms: number) => Promise<void>;
    }): Promise<{ deleted: number; batches: number; finished: boolean }> {
        const now = params.now ?? Date.now;
        const pause = params.sleep ?? sleep;
        const deadline = now() + params.budgetMs;

        let deleted = 0;
        let batches = 0;
        // Resume each batch where the last one stopped: walking the index
        // from the oldest row every time re-reads the rows that can never be
        // deleted (still referenced, CLI reviews) and grows with the backlog.
        let after: string | undefined;

        while (now() < deadline && !this.runGate.stopping) {
            const batch = await this.jobRepository.deleteFinishedOlderThan({
                olderThan: params.olderThan,
                batchSize: WORKFLOW_JOB_RETENTION_BATCH_SIZE,
                after,
                // try.kodus.io share links (/r/<jobId>) read the CLI review
                // job row, and a shared link must not die.
                keepWorkflowTypes: [WorkflowType.CLI_CODE_REVIEW],
            });
            deleted += batch.deleted;
            batches += 1;
            after = batch.lastUpdatedAt ?? after;

            if (batch.deleted < WORKFLOW_JOB_RETENTION_BATCH_SIZE) {
                return { deleted, batches, finished: true };
            }

            await pause(params.pauseMs);
        }

        return { deleted, batches, finished: false };
    }

    private async acquireLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:WORKFLOW_JOB_RETENTION',
                { ttl: RUN_BUDGET_MS + 5 * 60 * 1000 },
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire workflow job retention lock',
                context: WorkflowJobRetentionService.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }
}
