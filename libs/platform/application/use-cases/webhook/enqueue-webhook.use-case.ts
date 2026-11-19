import { Injectable, Inject } from '@nestjs/common';
import { IdGenerator } from '@libs/core/utils/id-generator';

import {
    PlatformType,
    parsePlatformType,
} from '@libs/core/domain/enums/platform-type.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

export interface EnqueueWebhookInput {
    platformType: PlatformType | string;
    event: string;
    payload: Record<string, unknown>;
    correlationId?: string;
}

@Injectable()
export class EnqueueWebhookUseCase implements IUseCase {
    private readonly logger = createLogger(EnqueueWebhookUseCase.name);

    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
    ) {}

    async execute(input: EnqueueWebhookInput): Promise<void> {
        try {
            const platformType = parsePlatformType(input.platformType);
            if (!platformType)
                throw new Error(
                    `Unsupported platformType: ${input.platformType}`,
                );
            const correlationId =
                input.correlationId || IdGenerator.correlationId();

            await this.jobQueueService.enqueue({
                correlationId,
                workflowType: WorkflowType.WEBHOOK_PROCESSING,
                handlerType: HandlerType.WEBHOOK_RAW,
                payload: input.payload,
                metadata: {
                    platformType,
                    event: input.event,
                },
                status: JobStatus.PENDING,
                priority: 0,
                retryCount: 0,
                maxRetries: 1,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to enqueue raw webhook payload',
                context: EnqueueWebhookUseCase.name,
                error,
                metadata: {
                    input,
                },
            });
            throw error;
        }
    }
}
