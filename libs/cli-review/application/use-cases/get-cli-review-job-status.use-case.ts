import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';
import { CliReviewJobPublicPrMetadata } from '@libs/cli-review/workflow/cli-review-job.types';

export interface GetCliReviewJobStatusInput {
    jobId: string;
    /**
     * The organization the caller belongs to. The use case checks the job
     * was enqueued by this org and throws NotFound otherwise — never leak
     * the existence of jobs from other organizations.
     */
    organizationId: string;
    /**
     * When true, omit the heavy public-demo payload fields (`publicPr`
     * and `publicDiff`). The frontend caches both in sessionStorage
     * after the first poll, so subsequent polls only need status +
     * `result` and can skip ~15 KB of redundant transfer per tick.
     */
    omitPayload?: boolean;
}

export interface CliReviewJobStatusResponse {
    jobId: string;
    status: JobStatus;
    result?: CliReviewResponse;
    error?: string;
    createdAt: Date;
    startedAt?: Date | null;
    completedAt?: Date | null;
    /**
     * Public-demo only: original PR metadata + raw diff fetched at
     * enqueue time. Lets the demo UI re-render the file/diff tree from
     * any browser session (shared link, refresh, new tab), not only the
     * one that submitted the review.
     */
    publicPr?: CliReviewJobPublicPrMetadata;
    publicDiff?: string;
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
        const { jobId, organizationId, omitPayload = false } = input;

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

        const payload = (job as any).payload as
            | { publicPr?: CliReviewJobPublicPrMetadata; publicDiff?: string }
            | undefined;

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
            ...(!omitPayload && payload?.publicPr
                ? { publicPr: payload.publicPr }
                : {}),
            ...(!omitPayload && payload?.publicDiff
                ? { publicDiff: payload.publicDiff }
                : {}),
        };
    }
}
