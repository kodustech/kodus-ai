import { Injectable, Inject } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import {
    IJobStatusService,
    JOB_STATUS_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-status.service.contract';
import { ICodeReviewJob } from '../../domain/interfaces/code-review-job.interface';

export interface GetJobStatusInput {
    jobId: string;
}

export interface GetJobStatusOutput {
    job: ICodeReviewJob | null;
    executionHistory: Array<{
        id: string;
        attemptNumber: number;
        status: string;
        startedAt: Date;
        completedAt?: Date;
        durationMs?: number;
        errorType?: string;
        errorMessage?: string;
    }>;
}

@Injectable()
export class GetJobStatusUseCase implements IUseCase {
    private readonly logger = createLogger(GetJobStatusUseCase.name);

    constructor(
        @Inject(JOB_STATUS_SERVICE_TOKEN)
        private readonly jobStatusService: IJobStatusService,
    ) {}

    async execute(input: GetJobStatusInput): Promise<GetJobStatusOutput> {
        try {
            const detail = await this.jobStatusService.getJobDetail(
                input.jobId,
            );

            if (!detail) {
                return {
                    job: null,
                    executionHistory: [],
                };
            }

            return {
                //TODO: Remover isso quando o job for implementado
                //job: detail.job,
                job: null,
                executionHistory: detail.executionHistory.map((h) => ({
                    id: h.id,
                    attemptNumber: h.attemptNumber,
                    status: h.status,
                    startedAt: h.startedAt,
                    completedAt: h.completedAt,
                    durationMs: h.durationMs,
                    errorType: h.errorType,
                    errorMessage: h.errorMessage,
                })),
            };
        } catch (error) {
            this.logger.error({
                message: 'Failed to get job status',
                context: GetJobStatusUseCase.name,
                error,
                metadata: {
                    jobId: input.jobId,
                },
            });
            throw error;
        }
    }
}
