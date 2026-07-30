import { Injectable, Inject } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IJobProcessorService,
    JOB_PROCESSOR_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { createLogger } from '@libs/core/log/logger';
import { ObservabilityService } from '@libs/core/log/observability.service';

export interface ProcessWorkflowJobInput {
    jobId: string;
}

@Injectable()
export class ProcessWorkflowJobUseCase implements IUseCase {
    private readonly logger = createLogger(ProcessWorkflowJobUseCase.name);

    constructor(
        @Inject(JOB_PROCESSOR_SERVICE_TOKEN)
        private readonly jobProcessor: IJobProcessorService,
        private readonly observability: ObservabilityService,
    ) {}

    async execute(input: ProcessWorkflowJobInput): Promise<void> {
        return await this.observability.runInSpan(
            'workflow.job.process.use-case',
            async (span) => {
                span.setAttributes({
                    'workflow.job.id': input.jobId,
                });

                this.logger.log({
                    message: 'Processing workflow job',
                    context: ProcessWorkflowJobUseCase.name,
                    metadata: {
                        jobId: input.jobId,
                    },
                });

                try {
                    await this.jobProcessor.process(input.jobId);

                    span.setAttributes({
                        'workflow.job.processed': true,
                    });
                } catch (error) {
                    span.setAttributes({
                        'error': true,
                        'exception.type': error.name,
                        'exception.message': error.message,
                    });

                    this.logger.error({
                        message: 'Failed to process workflow job',
                        context: ProcessWorkflowJobUseCase.name,
                        error,
                        metadata: {
                            jobId: input.jobId,
                        },
                    });

                    throw error;
                }
            },
            {
                'workflow.component': 'use-case',
                'workflow.operation': 'process_job',
            },
        );
    }
}
