import {
    Controller,
    ForbiddenException,
    Get,
    Inject,
    NotFoundException,
    Param,
    Query,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';

import { GetCliReviewByIdUseCase } from '@libs/cli-review/application/use-cases/dashboard/get-cli-review-by-id.use-case';
import { GetCliReviewsUseCase } from '@libs/cli-review/application/use-cases/dashboard/get-cli-reviews.use-case';
import {
    CliReviewDetail,
    PaginatedCliReviews,
} from '@libs/cli-review/dtos/cli-review-summary.dto';
import { CliReviewsQueryDto } from '@libs/cli-review/dtos/cli-reviews-query.dto';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

@ApiTags('CLI Reviews')
@ApiStandardResponses()
@Controller('cli-reviews')
export class CliReviewsController {
    constructor(
        private readonly getCliReviewsUseCase: GetCliReviewsUseCase,
        private readonly getCliReviewByIdUseCase: GetCliReviewByIdUseCase,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly authorizationService: AuthorizationService,
    ) {}

    /** The repositories the caller may read CLI reviews of; null for all. */
    private readableRepositories(): Promise<string[] | null> {
        return this.authorizationService.getRepositoryScope({
            user: this.request.user,
            action: Action.Read,
            resource: ResourceType.CliReview,
        });
    }

    @Get('/executions')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CliReview,
        }),
    )
    @ApiOperation({
        summary: 'List CLI review executions',
        description:
            'Returns the CLI review execution history (origin=cli) with pagination. Filters: teamId, repositoryId, userEmail, since.',
    })
    @ApiOkResponse({ description: 'Paginated CLI review summaries' })
    async list(
        @Query() query: CliReviewsQueryDto,
    ): Promise<PaginatedCliReviews> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new UnauthorizedException(
                'Authenticated organization not found',
            );
        }

        // A member limited to some repositories (assignment, or the Git
        // connections they are granted) reads one of theirs at a time.
        const readable = await this.readableRepositories();
        if (
            readable !== null &&
            (!query.repositoryId || !readable.includes(query.repositoryId))
        ) {
            throw new ForbiddenException(
                'Choose one of the repositories you can read (repositoryId).',
            );
        }

        return this.getCliReviewsUseCase.execute({
            organizationAndTeamData: {
                organizationId,
                teamId: query.teamId,
            },
            repositoryId: query.repositoryId,
            userEmail: query.userEmail,
            since: query.since ? new Date(query.since) : undefined,
            page: query.page,
            pageSize: query.pageSize,
        });
    }

    @Get('/:executionUuid')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CliReview,
        }),
    )
    @ApiOperation({
        summary: 'Get a CLI review by id',
        description:
            'Returns full detail (timeline + suggestions/result) for a single CLI review execution.',
    })
    @ApiOkResponse({ description: 'CLI review detail' })
    async detail(
        @Param('executionUuid') executionUuid: string,
    ): Promise<CliReviewDetail> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new UnauthorizedException(
                'Authenticated organization not found',
            );
        }
        const review = await this.getCliReviewByIdUseCase.execute({
            executionUuid,
            organizationId,
        });
        const readable = await this.readableRepositories();
        if (
            readable !== null &&
            !readable.includes(String(review?.repositoryId ?? ''))
        ) {
            throw new NotFoundException('CLI review not found');
        }
        return review;
    }
}
