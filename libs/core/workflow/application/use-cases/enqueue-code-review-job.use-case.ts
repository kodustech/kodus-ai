import { Injectable, Inject } from '@nestjs/common';
import { IdGenerator, createLogger } from '@kodus/flow';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export type EnqueueCodeReviewJobInput = {
    codeManagementPayload: any;
    event: string;
    platformType: PlatformType;
    organizationAndTeamData: OrganizationAndTeamData;
    teamAutomationId: string;
    correlationId?: string;
    workflowJobId?: string;
};

@Injectable()
export class EnqueueCodeReviewJobUseCase implements IUseCase {
    private readonly logger = createLogger(EnqueueCodeReviewJobUseCase.name);

    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
    ) {}

    async execute(input: EnqueueCodeReviewJobInput): Promise<string> {
        try {
            const correlationId =
                input.correlationId || IdGenerator.correlationId();

            // TODO: Documentar melhor aqui que esse payload é o que precisa para executar o processo de review.
            const jobPayload = {
                event: input.event,
                //action: 'code_review_requested', // TODO: ver depois mas ter uma noção melhor do evento se foi de openpr ou sync, update
                platformType: input.platformType,
                codeManagementPayload: input.codeManagementPayload,
                organizationAndTeamData: input.organizationAndTeamData,
                teamAutomationId: input.teamAutomationId,
            };

            const jobId = await this.jobQueueService.enqueue({
                correlationId,
                workflowType: WorkflowType.CODE_REVIEW,
                handlerType: HandlerType.PIPELINE_SYNC,
                payload: jobPayload,
                organizationAndTeamData: input.organizationAndTeamData,
                status: JobStatus.PENDING,
                priority: 0, // ENTENDER esse priority aqui
                retryCount: 0,
                maxRetries: 1,
            });

            return jobId;
        } catch (error) {
            this.logger.error({
                message: 'Failed to enqueue code review job',
                context: EnqueueCodeReviewJobUseCase.name,
                error,
                metadata: {
                    input,
                },
            });
            throw error;
        }
    }
}
