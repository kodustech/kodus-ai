import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';

export interface GetCliReviewJobStatusInput {
    jobId: string;
    /**
     * The organization the caller belongs to. The use case checks the job
     * was enqueued by this org and throws NotFound otherwise — never leak
     * the existence of jobs from other organizations.
     */
    organizationId: string;
}

export interface CliReviewJobStatusResponse {
    jobId: string;
    status: JobStatus;
    result?: CliReviewResponse;
    error?: string;
    createdAt: Date;
    startedAt?: Date | null;
    completedAt?: Date | null;
}

/**
 * Look up a single CLI review job by id, verify it belongs to the caller's
 * organization, and return the public-facing status payload. Encapsulates
 * the IJobQueueService dependency so the controller stays thin.
 */
@Injectable()
export class GetCliReviewJobStatusUseCase
    implements IUseCase<GetCliReviewJobStatusInput, CliReviewJobStatusResponse>
{
    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
    ) {}

    async execute(
        input: GetCliReviewJobStatusInput,
    ): Promise<CliReviewJobStatusResponse> {
        const { jobId, organizationId } = input;

        const job = await this.jobQueueService.getStatus(jobId);
        if (!job) {
            throw new NotFoundException(`CLI review job ${jobId} not found`);
        }

        if (job.workflowType !== WorkflowType.CLI_CODE_REVIEW) {
            throw new NotFoundException(`CLI review job ${jobId} not found`);
        }

        const jobOrgId =
            (job as any).organizationAndTeamData?.organizationId ??
            (job as any).organizationId;
        if (jobOrgId && jobOrgId !== organizationId) {
            // Hide cross-tenant existence behind the same NotFound message.
            throw new NotFoundException(`CLI review job ${jobId} not found`);
        }

        const result =
            job.status === JobStatus.COMPLETED
                ? ((job.metadata as any)?.result as
                      | CliReviewResponse
                      | undefined)
                : undefined;

        return {
            jobId,
            status: job.status,
            ...(result ? { result } : {}),
            ...(job.status === JobStatus.FAILED && job.lastError
                ? { error: job.lastError }
                : {}),
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
        };
    }
}
