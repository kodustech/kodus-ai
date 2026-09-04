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

@Injectable()
export class WorkflowJobRepository implements IWorkflowJobRepository {
    private readonly logger = createLogger(WorkflowJobRepository.name);

    constructor(
        @InjectRepository(WorkflowJobModel)
        private readonly repository: Repository<WorkflowJobModel>,
    ) {}

    async create(
        job: Omit<IWorkflowJob, 'id' | 'createdAt' | 'updatedAt'>,
        transactionManager?: EntityManager,
    ): Promise<WorkflowJobModel> {
        try {
            const repo = transactionManager
                ? transactionManager.getRepository(WorkflowJobModel)
                : this.repository;

            const model = repo.create({
                correlationId: job.correlationId,
                idempotencyKey: job.idempotencyKey,
                workflowType: job.workflowType,
                handlerType: job.handlerType,
                payload: job.payload,
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
                metadata: job.metadata,
                waitingForEvent: job.waitingForEvent,
                pipelineState: job.pipelineState,
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
            if (data.metadata !== undefined)
                updateData.metadata = data.metadata;
            if (data.waitingForEvent !== undefined)
                updateData.waitingForEvent = data.waitingForEvent;
            if (data.pipelineState !== undefined)
                updateData.pipelineState = data.pipelineState;
            if (data.payload !== undefined) updateData.payload = data.payload;

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

    async findIdByIdempotencyKey(
        idempotencyKey: string,
    ): Promise<string | null> {
        const model = await this.repository.findOne({
            where: { idempotencyKey },
            select: { uuid: true },
        });
        return model?.uuid ?? null;
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

    async getExecutionHistory(_jobId: string): Promise<IJobExecutionHistory[]> {
        // TODO: Implement execution history tracking if needed
        // For now, return empty array as we don't have a separate execution_history table
        return [];
    }

    private mapToInterface(model: WorkflowJobModel): IWorkflowJob {
        return {
            id: model.uuid,
            correlationId: model.correlationId,
            idempotencyKey: model.idempotencyKey,
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
