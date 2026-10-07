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

    /**
     * Update a job.
     *
     * `guard` (#1830 review) makes the write conditional on the caller still
     * owning the job: it only lands when the row's `leaseOwner` still matches
     * (and, unless `requireProcessing` is false, when it is still PROCESSING).
     * In that mode the method returns whether the write landed, so a worker
     * whose lease was reclaimed can stop instead of overwriting the state of
     * whoever took the job over. Without a guard it keeps the old contract and
     * returns the refreshed job.
     *
     * `{ noLiveOwner: true }` is the other side of the same coin, for a caller
     * that holds NO lease: the write only lands when no worker is running the
     * job (`status <> PROCESSING`, or a lease that has already expired). Used
     * by the failure path reached without a lease, which must still stop a
     * redelivery without stamping over a live worker's row.
     */
    async update(
        id: string,
        data: Partial<IWorkflowJob>,
        guard?:
            | { leaseOwner: string; requireProcessing?: boolean }
            | { noLiveOwner: true },
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
            if (data.leaseOwner !== undefined)
                updateData.leaseOwner = data.leaseOwner;
            if (data.leaseExpiresAt !== undefined)
                updateData.leaseExpiresAt = data.leaseExpiresAt;
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

            if (guard && 'noLiveOwner' in guard) {
                // No-live-owner mode (#1830 review): the caller holds no lease
                // of its own and wants to stamp a terminal status only if no
                // worker is running the job. Two deliveries of the same jobId
                // can be consumed concurrently — process() does not check the
                // row status on entry, the inbox dedupes on
                // (consumerId, messageId) rather than jobId, and the reaper
                // republishes a reclaimed job with a fresh messageId — so an
                // unguarded write here can land FAILED over a row another
                // worker has already claimed PROCESSING. That worker's own
                // guarded completion then matches no row, its review result is
                // dropped, and the author gets a failure notice for a review
                // that is still running: the #1830 symptom the lease fence
                // exists to prevent. The condition is part of the UPDATE, not a
                // read before it, for the same reason as the lease guard below.
                const qb = this.repository
                    .createQueryBuilder()
                    .update(WorkflowJobModel)
                    .set(updateData)
                    .where('uuid = :uuid', { uuid: id })
                    .andWhere(
                        '(status <> :processing OR "leaseExpiresAt" IS NULL OR "leaseExpiresAt" < :now)',
                        {
                            processing: JobStatus.PROCESSING,
                            now: new Date(),
                        },
                    );
                const result = await qb.execute();
                return (result.affected ?? 0) > 0;
            }

            if (guard && !('noLiveOwner' in guard)) {
                // Ownership-conditional write. The row may have been reclaimed
                // by the reaper (leaseOwner replaced, status back to PENDING)
                // between this worker's last renewal and now, so the condition
                // has to be part of the UPDATE itself, not of a read before it.
                const qb = this.repository
                    .createQueryBuilder()
                    .update(WorkflowJobModel)
                    .set(updateData)
                    .where('uuid = :uuid', { uuid: id })
                    .andWhere('leaseOwner = :leaseOwner', {
                        leaseOwner: guard.leaseOwner,
                    });
                if (guard.requireProcessing !== false) {
                    qb.andWhere('status = :status', {
                        status: JobStatus.PROCESSING,
                    });
                }
                const result = await qb.execute();
                return (result.affected ?? 0) > 0;
            }

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
     * Lists PROCESSING jobs owned by a dead/slow worker (issue #1830): a job
     * with a lease whose `leaseExpiresAt` is in the past, or (for legacy rows
     * that pre-date the lease) a job whose `updatedAt` is older than
     * `olderThan`. A live worker renews the lease every ~30s, so an expired
     * lease is evidence of death — recovery drops from 180 min to ~90 s.
     */
    async findStaleProcessing(params: {
        now: Date;
        olderThan: Date;
    }): Promise<StaleWorkflowJobReapResult[]> {
        try {
            // The entity is aliased here, in the builder itself: a bare
            // `createQueryBuilder()` leaves `WorkflowJobModel` in FROM under its
            // default alias, so a following `.from(WorkflowJobModel, 'job')`
            // adds a SECOND entry and cross-joins the table with itself. Every
            // stale job then came back once per row in `workflow_jobs`, the uuid
            // list blew past Postgres' 65,535 bind-parameter limit and nothing
            // was ever reclaimed — the exact failure this reaper exists to fix
            // (#1830 review).
            const result = await this.repository
                .createQueryBuilder('job')
                // Columns are quoted and alias-qualified: unquoted mixed-case
                // identifiers are folded to lowercase by Postgres, so a bare
                // `workflowType` selects `workflowtype` and errors out.
                .select([
                    'job."uuid"',
                    'job."workflowType"',
                    'job."organizationId"',
                    'job."startedAt"',
                    'job."leaseExpiresAt"',
                    'job."retryCount"',
                    'job."maxRetries"',
                ])
                .where('job.status = :status', { status: JobStatus.PROCESSING })
                // The whole disjunction is wrapped in its own parens so the
                // `status = PROCESSING` guard applies to BOTH branches. Emitted
                // bare, SQL precedence would parse this as
                // `(status AND lease-expired) OR (legacy)` and the legacy branch
                // would match every old row — including COMPLETED/FAILED ones —
                // on every run.
                .andWhere(
                    '((job."leaseExpiresAt" IS NOT NULL AND job."leaseExpiresAt" < :now)' +
                        ' OR ' +
                        '(job."leaseExpiresAt" IS NULL AND job."updatedAt" < :olderThan))',
                    { now: params.now, olderThan: params.olderThan },
                )
                .getRawMany();

            return (result ?? []) as StaleWorkflowJobReapResult[];
        } catch (error) {
            this.logger.error({
                message: 'Failed to find stale PROCESSING workflow jobs',
                context: WorkflowJobRepository.name,
                error,
                metadata: {
                    now: params.now.toISOString(),
                    olderThan: params.olderThan.toISOString(),
                },
            });
            throw error;
        }
    }

    /**
     * Returns a reclaimed job to PENDING with retryCount + 1 and clears its
     * lease + run state, so a fresh trigger re-processes it instead of the job
     * being permanently failed and reported forever as PROCESSING.
     */
    async requeueStaleJobs(params: {
        uuids: string[];
        lastError: string;
        requeuedBy: string;
        // Tenant(s) the batch belongs to. Logged next to the uuids so a reclaim
        // can be traced back to an organization: a bare uuid list cannot be
        // filtered per customer in the log system.
        organizationIds?: string[];
    }): Promise<string[]> {
        if (params.uuids.length === 0) {
            return [];
        }
        try {
            const result = await this.repository
                .createQueryBuilder()
                .update(WorkflowJobModel)
                .set({
                    status: JobStatus.PENDING,
                    retryCount: () => '"retryCount" + 1',
                    lastError: params.lastError,
                    errorClassification: null,
                    startedAt: null,
                    completedAt: null,
                    leaseOwner: null,
                    leaseExpiresAt: null,
                    currentStage: null,
                })
                .whereInIds(params.uuids)
                // Re-assert PROCESSING in the UPDATE: a job can complete (or be
                // permanently failed) between the SELECT that listed it as stale
                // and this write. Without the guard the UPDATE clears a newer
                // terminal state to PENDING and the job re-runs.
                .andWhere('status = :status', { status: JobStatus.PROCESSING })
                // PostgreSQL RETURNING tells us exactly which rows we flipped —
                // the watchdog republishes only these, never the full candidate
                // batch, so a job that finished between the SELECT and this
                // UPDATE is not re-driven (#1902).
                .returning('uuid')
                .execute();
            const rows = (result.raw ?? []) as Array<{ uuid?: string }>;
            const requeuedUuids = rows
                .map((r) => r.uuid)
                .filter((u): u is string => typeof u === 'string');
            if (requeuedUuids.length > 0) {
                this.logger.log({
                    message: `Requeued ${requeuedUuids.length} stale PROCESSING workflow job(s) to PENDING`,
                    context: WorkflowJobRepository.name,
                    metadata: {
                        organizationIds: params.organizationIds ?? [],
                        requested: params.uuids.length,
                        requeued: requeuedUuids.length,
                        requeuedUuids,
                    },
                });
            }
            return requeuedUuids;
        } catch (error) {
            this.logger.error({
                message: 'Failed to requeue stale PROCESSING workflow jobs',
                context: WorkflowJobRepository.name,
                error,
                metadata: { uuids: params.uuids },
            });
            throw error;
        }
    }

    /**
     * Terminally fails reclaimed jobs whose retry budget is exhausted.
     */
    async failStaleJobs(params: {
        uuids: string[];
        lastError: string;
        errorClassification: ErrorClassification;
    }): Promise<number> {
        if (params.uuids.length === 0) {
            return 0;
        }
        try {
            const result = await this.repository
                .createQueryBuilder()
                .update(WorkflowJobModel)
                .set({
                    status: JobStatus.FAILED,
                    errorClassification: params.errorClassification,
                    lastError: params.lastError,
                    completedAt: () => 'NOW()',
                    leaseOwner: null,
                    leaseExpiresAt: null,
                })
                .whereInIds(params.uuids)
                // Same re-check as requeueStaleJobs: only a still-PROCESSING row
                // may be terminally failed, so a job that completed between the
                // SELECT and this UPDATE is never clobbered to FAILED.
                .andWhere('status = :status', { status: JobStatus.PROCESSING })
                .execute();
            return result.affected ?? 0;
        } catch (error) {
            this.logger.error({
                message: 'Failed to permanently fail stale workflow jobs',
                context: WorkflowJobRepository.name,
                error,
                metadata: { uuids: params.uuids },
            });
            throw error;
        }
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
