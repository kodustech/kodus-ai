import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository, EntityManager } from 'typeorm';

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

    async update(id: string, data: Partial<IWorkflowJob>): Promise<any> {
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

            if (data.metadata !== undefined) updateData.metadata = patch.metadata;
            if (data.waitingForEvent !== undefined)
                updateData.waitingForEvent = patch.waitingForEvent;
            if (data.pipelineState !== undefined)
                updateData.pipelineState = patch.pipelineState;
            if (data.payload !== undefined) updateData.payload = patch.payload;

            await this.repository.update({ uuid: id }, updateData);

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

    /**
     * Deletes one batch of finished jobs last touched before `olderThan`,
     * oldest first, and returns how many it read, how many went, and the
     * `updatedAt` of the newest one it read. Pass that back as `after` so the
     * next batch starts there instead of re-walking rows it can never delete.
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
        keepWorkflowTypes?: WorkflowType[];
    }): Promise<{
        deleted: number;
        candidates: number;
        lastUpdatedAt?: string;
    }> {
        // `scan` walks idx_workflow_jobs_updated_at for the next batch and
        // stops there (MATERIALIZED keeps the LIMIT before the anti-joins):
        // planned as one query, the anti-joins read all of inbox and outbox
        // into hashes and sorted every finished job, which on a 12M-row copy
        // spilled to disk until it ran out. The message checks then probe the
        // job_id indexes for those rows only.
        //
        // The DELETE repeats the candidate predicates: a row updated while
        // the DELETE waited on its lock (FAILED retried back to PENDING) is
        // re-checked against them and kept, not deleted by its uuid alone.
        // Rows a message still holds are read and skipped, so the cursor
        // moves past them.
        const raw = await this.repository.query(
            `WITH scan AS MATERIALIZED (
                    SELECT j."uuid", j."updatedAt"
                      FROM "kodus_workflow"."workflow_jobs" j
                     WHERE j."updatedAt" < $1
                       AND ($6::timestamp IS NULL OR j."updatedAt" >= $6::timestamp)
                       AND j."status" IN ($2, $3, $4)
                       AND j."workflowType"::text <> ALL($7::text[])
                     ORDER BY j."updatedAt"
                     LIMIT $5
             ),
             doomed AS (
                    SELECT s."uuid"
                      FROM scan s
                     WHERE NOT EXISTS (SELECT 1 FROM "kodus_workflow"."inbox_messages" i WHERE i."job_id" = s."uuid")
                       AND NOT EXISTS (SELECT 1 FROM "kodus_workflow"."outbox_messages" o WHERE o."job_id" = s."uuid")
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
                    (SELECT max(s."updatedAt")::text FROM scan s) AS "lastUpdatedAt"`,
            [
                params.olderThan,
                JobStatus.COMPLETED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
                params.batchSize,
                params.after ?? null,
                params.keepWorkflowTypes ?? [],
            ],
        );

        const row = (Array.isArray(raw) ? raw[0] : raw) as
            | {
                  candidates: number;
                  deleted: number;
                  lastUpdatedAt: string | null;
              }
            | undefined;

        return {
            deleted: row?.deleted ?? 0,
            candidates: row?.candidates ?? 0,
            lastUpdatedAt: row?.lastUpdatedAt ?? undefined,
        };
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
