import { Inject, Injectable } from '@nestjs/common';

import { sleep } from '@libs/common/utils/helpers';
import {
    cronRunGate,
    GatedCron,
} from '@libs/core/infrastructure/services/cron-run-gate';
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
export class WorkflowJobRetentionService {
    private readonly logger = createLogger(WorkflowJobRetentionService.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    // 06:00 UTC: night in the Americas, before the European morning.
    @GatedCron('0 6 * * *', {
        name: 'workflow-job-retention',
        timeZone: 'UTC',
    })
    async purgeFinishedJobs(): Promise<void> {
        await this.purge();
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
                error: error as Error,
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

        let referenceRaces = 0;

        while (now() < deadline && !cronRunGate.stopping) {
            let batch: {
                deleted: number;
                candidates: number;
                lastUpdatedAt?: string;
            };
            const startedAt = now();
            try {
                batch = await this.jobRepository.deleteFinishedOlderThan({
                    olderThan: params.olderThan,
                    batchSize: WORKFLOW_JOB_RETENTION_BATCH_SIZE,
                    after,
                    // try.kodus.io share links (/r/<jobId>) read the CLI
                    // review job row, and a shared link must not die.
                    keepWorkflowTypes: [WorkflowType.CLI_CODE_REVIEW],
                });
            } catch (error) {
                // A message inserted for a doomed job after the batch read
                // its candidates fails the whole statement on the FK. Run the
                // batch again: its new read sees the message and keeps the job.
                if (
                    isForeignKeyViolation(error) &&
                    referenceRaces < MAX_REFERENCE_RACES
                ) {
                    referenceRaces += 1;
                    continue;
                }
                throw error;
            }
            referenceRaces = 0;
            deleted += batch.deleted;
            batches += 1;
            after = batch.lastUpdatedAt ?? after;

            // One line per batch: a run cut short still shows how far it
            // got, and the first prod run shows what a batch costs there.
            this.logger.log({
                message: 'Workflow job retention batch',
                context: WorkflowJobRetentionService.name,
                metadata: {
                    batch: batches,
                    candidates: batch.candidates,
                    deleted: batch.deleted,
                    after,
                    durationMs: now() - startedAt,
                },
            });

            // Read fewer than a full batch: nothing older is left. Rows read
            // but kept (updated meanwhile) do not end the scan.
            if (batch.candidates < WORKFLOW_JOB_RETENTION_BATCH_SIZE) {
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

/** Same batch retried at most this many times in a row on an FK race. */
const MAX_REFERENCE_RACES = 3;

function isForeignKeyViolation(error: unknown): boolean {
    const e = error as { code?: unknown; driverError?: { code?: unknown } };
    return (e?.driverError?.code ?? e?.code) === '23503';
}
