import { Injectable, Inject } from '@nestjs/common';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { CheckImplementationJobPayload } from '../../domain/interfaces/check-implementation-job.interface';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { IdGenerator } from '@libs/core/utils/id-generator';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';

@Injectable()
export class EnqueueImplementationCheckUseCase implements IUseCase {
    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
    ) {}

    async execute(input: CheckImplementationJobPayload): Promise<string> {
        const correlationId =
            input.correlationId || IdGenerator.correlationId();

        // Pass the input as payload directly
        const jobPayload = { ...input };

        return this.jobQueueService.enqueue({
            correlationId: correlationId,
            workflowType: WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION,
            handlerType: HandlerType.SIMPLE_FUNCTION,
            payload: jobPayload,
            organizationAndTeamData: input.organizationAndTeamData,
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 1,
        });
    }
}
