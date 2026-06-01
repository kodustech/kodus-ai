import { Injectable, Inject } from '@nestjs/common';
import { IdGenerator, createLogger } from '@kodus/flow';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import { CliReviewJobPayload } from '@libs/cli-review/workflow/cli-review-job.types';

export interface EnqueueCliReviewInput extends CliReviewJobPayload {
    correlationId?: string;
}

export interface EnqueueCliReviewResult {
    jobId: string;
    correlationId: string;
}

@Injectable()
export class EnqueueCliReviewUseCase implements IUseCase {
    private readonly logger = createLogger(EnqueueCliReviewUseCase.name);

    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
    ) {}

    async execute(
        input: EnqueueCliReviewInput,
    ): Promise<EnqueueCliReviewResult> {
        const correlationId = input.correlationId || IdGenerator.correlationId();

        const payload: CliReviewJobPayload = {
            organizationAndTeamData: input.organizationAndTeamData,
            input: input.input,
            isTrialMode: input.isTrialMode,
            userEmail: input.userEmail,
            gitContext: input.gitContext,
            cliAuth: input.cliAuth,
        };

        const jobId = await this.jobQueueService.enqueue({
            correlationId,
            workflowType: WorkflowType.CLI_CODE_REVIEW,
            handlerType: HandlerType.PIPELINE_ASYNC,
            payload: payload as unknown as Record<string, unknown>,
            organizationAndTeamData: input.organizationAndTeamData,
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 1,
        });

        return { jobId, correlationId };
    }
}
