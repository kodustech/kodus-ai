import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    CliReviewSummary,
    PaginatedCliReviews,
} from '@libs/cli-review/dtos/cli-review-summary.dto';
import { mapExecutionToSummary } from './cli-reviews.mapper';

export interface GetCliReviewsInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId?: string;
    userEmail?: string;
    since?: Date;
    page?: number;
    pageSize?: number;
}

@Injectable()
export class GetCliReviewsUseCase
    implements IUseCase<GetCliReviewsInput, PaginatedCliReviews>
{
    private readonly logger = createLogger(GetCliReviewsUseCase.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
    ) {}

    async execute(input: GetCliReviewsInput): Promise<PaginatedCliReviews> {
        const page = Math.max(1, input.page ?? 1);
        const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 30));
        const skip = (page - 1) * pageSize;

        const { data, total } =
            await this.automationExecutionService.findCliReviewExecutionsByOrganization(
                {
                    organizationAndTeamData: input.organizationAndTeamData,
                    repositoryId: input.repositoryId,
                    userEmail: input.userEmail,
                    since: input.since,
                    skip,
                    take: pageSize,
                    order: 'DESC',
                    includeTotal: true,
                },
            );

        const summaries: CliReviewSummary[] = data.map((execution) =>
            mapExecutionToSummary(execution),
        );

        return {
            data: summaries,
            total,
            page,
            pageSize,
            hasMore: skip + summaries.length < total,
        };
    }
}
