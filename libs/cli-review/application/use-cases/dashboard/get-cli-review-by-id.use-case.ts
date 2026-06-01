import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createLogger } from '@kodus/flow';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    CODE_REVIEW_EXECUTION_SERVICE,
    ICodeReviewExecutionService,
} from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';

import {
    CliReviewDetail,
    CliReviewTimelineItem,
} from '@libs/cli-review/dtos/cli-review-summary.dto';
import { mapExecutionToSummary } from './cli-reviews.mapper';

export interface GetCliReviewByIdInput {
    executionUuid: string;
    organizationId: string;
}

@Injectable()
export class GetCliReviewByIdUseCase
    implements IUseCase<GetCliReviewByIdInput, CliReviewDetail>
{
    private readonly logger = createLogger(GetCliReviewByIdUseCase.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(CODE_REVIEW_EXECUTION_SERVICE)
        private readonly codeReviewExecutionService: ICodeReviewExecutionService<IAutomationExecution>,
    ) {}

    async execute(input: GetCliReviewByIdInput): Promise<CliReviewDetail> {
        const execution = await this.automationExecutionService.findById(
            input.executionUuid,
        );

        if (!execution || execution.origin !== 'cli') {
            throw new NotFoundException('CLI review not found');
        }

        const ownerOrgId = (execution as any).teamAutomation?.team?.organization
            ?.uuid;
        if (ownerOrgId && ownerOrgId !== input.organizationId) {
            throw new NotFoundException('CLI review not found');
        }

        const codeReviewExecutions =
            await this.codeReviewExecutionService.findManyByAutomationExecutionIds(
                [execution.uuid],
            );

        const timeline: CliReviewTimelineItem[] = codeReviewExecutions.map(
            (cre) => ({
                uuid: cre.uuid,
                createdAt: cre.createdAt,
                updatedAt: cre.updatedAt,
                status: cre.status,
                stageName: cre.stageName ?? null,
                stageLabel:
                    (cre as any)?.metadata?.label ?? cre.stageName ?? null,
                message: cre.message,
                metadata: cre.metadata,
                finishedAt: cre.finishedAt ?? null,
            }),
        );

        const summary = mapExecutionToSummary(execution);

        return {
            ...summary,
            timeline,
            result: (execution.dataExecution as any)?.result,
        };
    }
}
