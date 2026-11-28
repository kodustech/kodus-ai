import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
    FindOptionsWhere,
    Repository,
    EntityManager,
    In,
    JsonContains,
    Raw,
} from 'typeorm';

import { createLogger } from '@libs/core/log/logger';
import {
    IWorkflowJobRepository,
    StaleWorkflowJobReapResult,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { IWorkflowJob } from '@libs/core/workflow/domain/interfaces/workflow-job.interface';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { IJobExecutionHistory } from '@libs/core/workflow/domain/interfaces/job-execution-history.interface';

import { WorkflowJobModel } from './schemas/workflow-job.model';
import { stripNulCharsWithReport } from './strip-nul';

@Injectable()
export class WorkflowJobRepository implements IWorkflowJobRepository {
    private readonly logger = createLogger(WorkflowJobRepository.name);

    constructor(
        @InjectRepository(WorkflowJobModel)
        private readonly repository: Repository<WorkflowJobModel>,
    ) {}

    /**
     * Strip NUL characters from every jsonb-bound field, and say so when it
     * happened.
     *
     * The stripping on its own is invisible by design: it turns a loud failure
     * into a quiet success. That is right for the customer and wrong for us --
     * without this log we would never learn how often a NUL arrives, which
     * field carries it, or whether it is one broken integration or a long tail.
     *
     * Logged at `warn`, not `error`: the job is saved and the review runs, so
     * nothing is broken any more; but content did change on the way in, and
     * that is worth someone's attention. Field PATHS only -- the values are
     * customer code and never belong in a log line.
     */
    private sanitizeJsonbFields<T extends Record<string, unknown>>(
        fields: T,
        context: Record<string, unknown>,
    ): T {
        const out = {} as T;
        const strippedPaths: string[] = [];

        for (const [field, value] of Object.entries(fields)) {
            if (value === undefined) {
                out[field as keyof T] = value as T[keyof T];
                continue;
            }

            const report = stripNulCharsWithReport(value);
            out[field as keyof T] = report.value as T[keyof T];

            if (report.stripped) {
                strippedPaths.push(
                    ...report.paths.map((path) => `${field}.${path}`),
                );
            }
        }

        if (strippedPaths.length) {
            this.logger.warn({
                message:
                    'Stripped NUL character(s) before writing jsonb — the row would have been rejected',
                context: WorkflowJobRepository.name,
                metadata: {
                    ...context,
                    strippedPaths,
                    strippedCount: strippedPaths.length,
                },
            });
        }

        return out;
    }

    async create(
        job: Omit<IWorkflowJob, 'id' | 'createdAt' | 'updatedAt'>,
        transactionManager?: EntityManager,
    ): Promise<WorkflowJobModel> {
        try {
            const repo = transactionManager
                ? transactionManager.getRepository(WorkflowJobModel)
                : this.repository;

            // The four jsonb columns below carry content this service did not
            // author -- webhook bodies, branch and file names, diffs, model
            // output. A single NUL in any of them makes PostgreSQL reject the
            // whole INSERT (`unsupported Unicode escape sequence`), the
            // transaction rolls back, and the webhook that asked for the review
            // is dropped with nothing the customer can see. Sanitising at the
            // column boundary is the only place that covers every producer.
            const sanitized = this.sanitizeJsonbFields(
                {
                    payload: job.payload,
                    metadata: job.metadata,
                    waitingForEvent: job.waitingForEvent,
                    pipelineState: job.pipelineState,
                },
                {
                    operation: 'create',
                    correlationId: job.correlationId,
                    workflowType: job.workflowType,
                    organizationId: job.organizationAndTeamData?.organizationId,
                },
            );

            const model = repo.create({
                correlationId: job.correlationId,
                workflowType: job.workflowType,
                handlerType: job.handlerType,
                payload: sanitized.payload,
                status: job.status,
                priority: job.priority,
                retryCount: job.retryCount,
                maxRetries: job.maxRetries,
                organizationId: job.organizationAndTeamData?.organizationId,
                teamId: job.organizationAndTeamData?.teamId,
                errorClassification: job.errorClassification,
                lastError: job.lastError,
                scheduledAt: job.scheduledAt,
                startedAt: job.startedAt,
                completedAt: job.completedAt,
                currentStage: job.currentStage,
                metadata: sanitized.metadata,
                waitingForEvent: sanitized.waitingForEvent,
                pipelineState: sanitized.pipelineState,
            });

            const saved = await repo.save(model);

            this.logger.debug({
                message: 'Workflow job created',
                context: WorkflowJobRepository.name,
                metadata: {
                    jobId: saved.uuid,
                    correlationId: saved.correlationId,
                    workflowType: saved.workflowType,
                },
            });

            return saved;
        } catch (error) {
            this.logger.error({
                message: 'Failed to create workflow job',
                context: WorkflowJobRepository.name,
                error,
            });
            throw error;
        }
    }

    async update(
        id: string,
        data: Partial<IWorkflowJob>,
        expectedStatus?: JobStatus | JobStatus[],
        expectedAttemptId?: string | null,
    ): Promise<any> {
        try {
            const updateData: Partial<WorkflowJobModel> = {};

            if (data.status !== undefined) updateData.status = data.status;
            if (data.priority !== undefined)
                updateData.priority = data.priority;
            if (data.retryCount !== undefined)
                updateData.retryCount = data.retryCount;
            if (data.maxRetries !== undefined)
                updateData.maxRetries = data.maxRetries;
            if (data.errorClassification !== undefined)
                updateData.errorClassification = data.errorClassification;
            if (data.lastError !== undefined)
                updateData.lastError = data.lastError;
            if (data.scheduledAt !== undefined)
                updateData.scheduledAt = data.scheduledAt;
            if (data.startedAt !== undefined)
                updateData.startedAt = data.startedAt;
            if (data.completedAt !== undefined)
                updateData.completedAt = data.completedAt;
            if (data.currentStage !== undefined)
                updateData.currentStage = data.currentStage;
            // Same jsonb constraint as create(): an UPDATE carrying a NUL
            // fails identically, and pipelineState is rewritten on every stage
            // transition -- the most frequent write of the four.
            const patch = this.sanitizeJsonbFields(
                {
                    payload: data.payload,
                    metadata: data.metadata,
                    waitingForEvent: data.waitingForEvent,
                    pipelineState: data.pipelineState,
                },
                { operation: 'update', jobId: id },
            );

            if (data.metadata !== undefined)
                updateData.metadata = patch.metadata;
            if (data.waitingForEvent !== undefined)
                updateData.waitingForEvent = patch.waitingForEvent;
            if (data.pipelineState !== undefined)
                updateData.pipelineState = patch.pipelineState;
            if (data.payload !== undefined) updateData.payload = patch.payload;

            // A graph job can time out while its final UPDATE is in flight.
            const result = await this.repository.update(
                {
                    uuid: id,
                    ...(expectedStatus && {
                        status: Array.isArray(expectedStatus)
                            ? In(expectedStatus)
                            : expectedStatus,
                    }),
                    ...(expectedAttemptId !== undefined && {
                        metadata:
                            expectedAttemptId === null
                                ? Raw(
                                      (alias) =>
                                          `(${alias} ->> 'attemptId') IS NULL`,
                                  )
                                : JsonContains({
                                      attemptId: expectedAttemptId,
                                  }),
                    }),
                },
                updateData,
            );
            if (expectedStatus && result?.affected === 0) return null;

            return await this.findOne(id);
        } catch (error) {
            this.logger.error({
                message: 'Failed to update workflow job',
                context: WorkflowJobRepository.name,
                error,
                metadata: { jobId: id },
            });
            throw error;
        }
    }

    async findOne(id: string): Promise<IWorkflowJob | null> {
        try {
            const model = await this.repository.findOne({
                where: { uuid: id },
            });

            if (!model) return null;

            return this.mapToInterface(model);
        } catch (error) {
            this.logger.error({
                message: 'Failed to find workflow job',
                context: WorkflowJobRepository.name,
                error,
                metadata: { jobId: id },
            });
            throw error;
        }
    }

    async findMany(query: {
        status?: JobStatus;
        workflowType?: WorkflowType;
        organizationId?: string;
        teamId?: string;
        correlationId?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ data: IWorkflowJob[]; total?: number }> {
        try {
            const where: FindOptionsWhere<WorkflowJobModel> = {};

            if (query.status) where.status = query.status;
            if (query.workflowType) where.workflowType = query.workflowType;
            if (query.organizationId)
                where.organizationId = query.organizationId;
            if (query.teamId) where.teamId = query.teamId;
            if (query.correlationId) where.correlationId = query.correlationId;

            const [models, total] = await this.repository.findAndCount({
                where,
                take: query.limit || 50,
                skip: query.offset || 0,
                order: { createdAt: 'DESC' },
            });

            return {
                data: models.map((m) => this.mapToInterface(m)),
                total,
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to find workflow jobs',
                context: WorkflowJobRepository.name,
                error,
                metadata: { query },
            });
            throw error;
        }
    }

    /**
     * Reaps jobs orphaned in PROCESSING by a crashed/evicted worker.
     *
     * Only `PROCESSING` rows are eligible (never `PENDING` or the
     * legitimately-paused `WAITING_FOR_EVENT`), and only those whose
     * `updatedAt` predates the cutoff — a job still making progress bumps
     * `updatedAt` (currentStage/pipelineState updates) and is left alone.
     * Single UPDATE ... RETURNING so the selection and mutation are atomic.
     */
    async failStaleProcessing(params: {
        olderThan: Date;
        lastError: string;
        errorClassification: ErrorClassification;
    }): Promise<StaleWorkflowJobReapResult[]> {
        try {
            const result = await this.repository
                .createQueryBuilder()
                .update(WorkflowJobModel)
                .set({
                    status: JobStatus.FAILED,
                    errorClassification: params.errorClassification,
                    lastError: params.lastError,
                    completedAt: () => 'NOW()',
                })
                .where('status = :status', { status: JobStatus.PROCESSING })
                .andWhere('"updatedAt" < :olderThan', {
                    olderThan: params.olderThan,
                })
                .returning([
                    'uuid',
                    'workflowType',
                    'organizationId',
                    'startedAt',
                    'payload',
                ])
                .execute();

            return (result.raw ?? []) as StaleWorkflowJobReapResult[];
        } catch (error) {
            this.logger.error({
                message: 'Failed to reap stale PROCESSING workflow jobs',
                context: WorkflowJobRepository.name,
                error,
                metadata: { olderThan: params.olderThan },
            });
            throw error;
        }
    }

    async cancelActiveByCorrelation(params: {
        correlationId: string;
        workflowType: string;
    }): Promise<number> {
        try {
            const result = await this.repository
                .createQueryBuilder()
                .update(WorkflowJobModel)
                .set({
                    status: JobStatus.CANCELLED,
                    completedAt: () => 'NOW()',
                })
                .where('"correlationId" = :correlationId', {
                    correlationId: params.correlationId,
                })
                .andWhere('"workflowType" = :workflowType', {
                    workflowType: params.workflowType,
                })
                .andWhere('status IN (:...statuses)', {
                    statuses: [JobStatus.PENDING, JobStatus.PROCESSING],
                })
                .execute();
            return result.affected ?? 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to cancel active workflow jobs',
                context: WorkflowJobRepository.name,
                error,
                metadata: {
                    correlationId: params.correlationId,
                    workflowType: params.workflowType,
                },
            });
            throw error;
        }
    }

    /**
     * Deletes one batch of finished jobs last touched before `olderThan`,
     * oldest first, and returns how many it read, how many went, and the
     * `updatedAt` and uuid of the last one it read. Pass them back as `after`
     * and `afterId` so the next batch starts right after it instead of
     * re-walking rows it can never delete.
     *
     * Jobs an inbox or outbox row still references are kept (both FKs are
     * ON DELETE NO ACTION; the outbox relay deletes processed messages after
     * 7 days, so what remains is a failed message someone may still inspect),
     * and so are the `keepWorkflowTypes` the caller names.
     *
     * Served by idx_workflow_jobs_updated_at and the job_id indexes on
     * inbox/outbox (migration WorkflowJobsRetentionIndexes); without the
     * job_id indexes every deleted row pays a sequential scan in the FK check.
     * `updatedAt` travels as text: the column is timestamp without time zone,
     * and a JS Date would shift it by the process time zone and drop the
     * microseconds.
     */
    async deleteFinishedOlderThan(params: {
        olderThan: Date;
        batchSize: number;
        after?: string;
        afterId?: string;
        keepWorkflowTypes?: WorkflowType[];
    }): Promise<{
        deleted: number;
        candidates: number;
        lastUpdatedAt?: string;
        lastId?: string;
    }> {
        // `scan` walks idx_workflow_jobs_updated_at for the next batch and
        // stops there (MATERIALIZED keeps the LIMIT ahead of the message
        // checks): planned as one query, the checks read all of inbox and
        // outbox into hashes and sorted every finished job, which on a
        // 12M-row copy spilled to disk until it ran out. The checks are
        // LIMIT 1 subqueries, not NOT EXISTS: the planner keeps them as one
        // job_id index probe per row instead of turning them into a join that
        // can still hash a whole message table.
        //
        // The DELETE repeats the candidate predicates: a row updated while
        // the DELETE waited on its lock (FAILED retried back to PENDING) is
        // re-checked against them and kept, not deleted by its uuid alone.
        // Rows a message still holds are read and skipped, so the cursor
        // moves past them. The cursor is ("updatedAt", uuid), exclusive: one
        // UPDATE stamps many rows with the same updatedAt, so a timestamp
        // alone either re-reads a held row forever or skips the rest of a
        // tie. Without `afterId`, every row at `after` is included.
        const raw = await this.repository.query(
            `WITH scan AS MATERIALIZED (
                    SELECT j."uuid", j."updatedAt"
                      FROM "kodus_workflow"."workflow_jobs" j
                     WHERE j."updatedAt" < $1
                       AND ($6::timestamp IS NULL
                            OR (j."updatedAt", j."uuid") > ($6::timestamp, COALESCE($8::uuid, '00000000-0000-0000-0000-000000000000'::uuid)))
                       AND j."status" IN ($2, $3, $4)
                       AND j."workflowType"::text <> ALL($7::text[])
                     ORDER BY j."updatedAt", j."uuid"
                     LIMIT $5
             ),
             last AS (
                    SELECT s."updatedAt", s."uuid"
                      FROM scan s
                     ORDER BY s."updatedAt" DESC, s."uuid" DESC
                     LIMIT 1
             ),
             doomed AS (
                    SELECT s."uuid"
                      FROM scan s
                     WHERE (SELECT 1 FROM "kodus_workflow"."inbox_messages" i WHERE i."job_id" = s."uuid" LIMIT 1) IS NULL
                       AND (SELECT 1 FROM "kodus_workflow"."outbox_messages" o WHERE o."job_id" = s."uuid" LIMIT 1) IS NULL
             ),
             gone AS (
                DELETE FROM "kodus_workflow"."workflow_jobs" w
                 USING doomed d
                 WHERE w."uuid" = d."uuid"
                   AND w."updatedAt" < $1
                   AND w."status" IN ($2, $3, $4)
                   AND w."workflowType"::text <> ALL($7::text[])
             RETURNING w."uuid"
             )
             SELECT (SELECT count(*) FROM scan)::int AS "candidates",
                    (SELECT count(*) FROM gone)::int AS "deleted",
                    (SELECT l."updatedAt"::text FROM last l) AS "lastUpdatedAt",
                    (SELECT l."uuid"::text FROM last l) AS "lastId"`,
            [
                params.olderThan,
                JobStatus.COMPLETED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
                params.batchSize,
                params.after ?? null,
                params.keepWorkflowTypes ?? [],
                params.afterId ?? null,
            ],
        );

        const row = (Array.isArray(raw) ? raw[0] : raw) as
            | {
                  candidates: number;
                  deleted: number;
                  lastUpdatedAt: string | null;
                  lastId: string | null;
              }
            | undefined;

        // The SELECT always answers one row; without it nothing is known
        // about the batch, and a 0 would read as "nothing left".
        if (!row) {
            throw new Error(
                'Workflow job retention batch returned no result row',
            );
        }
        return {
            deleted: row.deleted,
            candidates: row.candidates,
            lastUpdatedAt: row.lastUpdatedAt ?? undefined,
            lastId: row.lastId ?? undefined,
        };
    }

    async failIfProcessing(
        id: string,
        data: { lastError: string; errorClassification: ErrorClassification },
    ): Promise<boolean> {
        try {
            const result = await this.repository
                .createQueryBuilder()
                .update(WorkflowJobModel)
                .set({
                    status: JobStatus.FAILED,
                    errorClassification: data.errorClassification,
                    lastError: data.lastError,
                    completedAt: () => 'NOW()',
                })
                .where('uuid = :id', { id })
                .andWhere('status = :status', { status: JobStatus.PROCESSING })
                .execute();
            return (result.affected ?? 0) > 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to mark PROCESSING workflow job as FAILED',
                context: WorkflowJobRepository.name,
                error,
                metadata: { jobId: id },
            });
            throw error;
        }
    }

    /**
     * How many jobs the reapers failed in the last `windowMinutes` (their
     * lastError starts with `lastErrorPrefix`). Feeds the windowed loss alert.
     *
     * The cut-off is computed in SQL, on the clock that stamped the rows
     * (`completedAt` is set to NOW() by failStaleProcessing): a JS Date
     * against these `timestamp without time zone` columns shifts with the
     * process time zone. The reap also bumps `updatedAt`, so the same bound
     * on it lets idx_workflow_jobs_updated_at pick the few recent rows
     * instead of walking every FAILED job.
     */
    async countReapedSince(
        windowMinutes: number,
        lastErrorPrefix: string,
    ): Promise<number> {
        return this.repository
            .createQueryBuilder('job')
            .where('job.status = :status', { status: JobStatus.FAILED })
            .andWhere(
                'job."updatedAt" >= NOW() - make_interval(mins => :windowMinutes)',
                { windowMinutes },
            )
            .andWhere(
                'job."completedAt" >= NOW() - make_interval(mins => :windowMinutes)',
                { windowMinutes },
            )
            .andWhere('job."lastError" LIKE :prefix', {
                prefix: `${lastErrorPrefix.replace(/[\\%_]/g, '\\$&')}%`,
            })
            .getCount();
    }

    async getExecutionHistory(_jobId: string): Promise<IJobExecutionHistory[]> {
        // TODO: Implement execution history tracking if needed
        // For now, return empty array as we don't have a separate execution_history table
        return [];
    }

    private mapToInterface(model: WorkflowJobModel): IWorkflowJob {
        return {
            id: model.uuid,
            correlationId: model.correlationId,
            workflowType: model.workflowType,
            handlerType: model.handlerType,
            payload: model.payload,
            status: model.status,
            priority: model.priority,
            retryCount: model.retryCount,
            maxRetries: model.maxRetries,
            organizationAndTeamData: model.organizationId
                ? {
                      organizationId: model.organizationId,
                      teamId: model.teamId,
                  }
                : undefined,
            errorClassification: model.errorClassification,
            lastError: model.lastError,
            scheduledAt: model.scheduledAt,
            startedAt: model.startedAt,
            completedAt: model.completedAt,
            currentStage: model.currentStage,
            metadata: model.metadata,
            waitingForEvent: model.waitingForEvent,
            pipelineState: model.pipelineState,
            createdAt: model.createdAt,
            updatedAt: model.updatedAt,
        };
    }
}
