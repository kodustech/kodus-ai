import { UserRequest } from '@/config/types/http/user-request.type';
import { BackfillHistoricalPRsUseCase } from '@/core/application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { GetEnrichedPullRequestsUseCase } from '@/core/application/use-cases/pullRequests/get-enriched-pull-requests.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import {
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';
import { CodeManagementService } from '../../adapters/services/platformIntegration/codeManagement.service';
import { BackfillPRsDto } from '../dtos/backfill-prs.dto';
import { EnrichedPullRequestsQueryDto } from '../dtos/enriched-pull-requests-query.dto';
import { PaginatedEnrichedPullRequestsResponse } from '../dtos/paginated-enriched-pull-requests.dto';
import { OnboardingReviewModeSignalsQueryDto } from '../dtos/onboarding-review-mode-signals-query.dto';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';

@Controller('pull-requests')
export class PullRequestController {
    constructor(
        private readonly getEnrichedPullRequestsUseCase: GetEnrichedPullRequestsUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly backfillHistoricalPRsUseCase: BackfillHistoricalPRsUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
    ) {}

    @Get('/executions')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    public async getPullRequestExecutions(
        @Query() query: EnrichedPullRequestsQueryDto,
    ): Promise<PaginatedEnrichedPullRequestsResponse> {
        return await this.getEnrichedPullRequestsUseCase.execute(query);
    }

    @Get('/onboarding-signals')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    public async getOnboardingSignals(
        @Query() query: OnboardingReviewModeSignalsQueryDto,
    ) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('No organization found in request');
        }

        const { teamId, repositoryIds, limit } = query;

        const organizationAndTeamData = {
            organizationId,
            teamId,
        };

        return this.pullRequestsService.getOnboardingReviewModeSignals({
            organizationAndTeamData,
            repositoryIds,
            limit,
        });
    }

    // NOT USED IN WEB - INTERNAL USE ONLY
    @Post('/backfill')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.PullRequests,
        }),
    )
    public async backfillHistoricalPRs(@Body() body: BackfillPRsDto) {
        const { teamId, repositoryIds, startDate, endDate } = body;
        const organizationId = this.request.user?.organization?.uuid;

        const organizationAndTeamData = {
            organizationId,
            teamId,
        };

        let repositories = await this.codeManagementService.getRepositories({
            organizationAndTeamData,
        });

        if (!repositories || repositories.length === 0) {
            return {
                success: false,
                message: 'No repositories found',
            };
        }

        repositories = repositories.filter(
            (r: any) => r && (r.selected === true || r.isSelected === true),
        );

        if (repositoryIds && repositoryIds.length > 0) {
            repositories = repositories.filter(
                (r: any) =>
                    repositoryIds.includes(r.id) ||
                    repositoryIds.includes(String(r.id)),
            );
        }

        if (repositories.length === 0) {
            return {
                success: false,
                message: 'No selected repositories found',
            };
        }

        setImmediate(() => {
            this.backfillHistoricalPRsUseCase
                .execute({
                    organizationAndTeamData,
                    repositories: repositories.map((r: any) => ({
                        id: String(r.id),
                        name: r.name,
                        fullName:
                            r.fullName ||
                            r.full_name ||
                            `${r.organizationName || ''}/${r.name}`,
                    })),
                    startDate,
                    endDate,
                })
                .catch((error) => {
                    console.error('Error during manual PR backfill:', error);
                });
        });

        return {
            success: true,
            message: 'PR backfill started in background',
            repositoriesCount: repositories.length,
        };
    }
}
