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

import { CreateOrUpdatePullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/create-or-update-pull-request-messages.use-case';
import { FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/find-by-repo-or-directory.use-case';
import { FindOverrideCountsByRepositoryPullRequestMessagesUseCase } from '@libs/code-review/application/use-cases/pullRequestMessages/find-override-counts-by-repository.use-case';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    ApiBearerAuth,
    ApiBody,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { PullRequestMessagesOverrideCountsResponseDto } from '../dtos/pull-request-messages-override-counts-response.dto';
import { PullRequestMessagesResponseDto } from '../dtos/pull-request-messages-response.dto';
import { PullRequestMessagesUpsertDto } from '../dtos/pull-request-messages-upsert.dto';

@ApiTags('Pull Request Messages')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('pull-request-messages')
export class PullRequestMessagesController {
    constructor(
        private readonly createOrUpdatePullRequestMessagesUseCase: CreateOrUpdatePullRequestMessagesUseCase,
        private readonly findByRepositoryOrDirectoryIdPullRequestMessagesUseCase: FindByRepositoryOrDirectoryIdPullRequestMessagesUseCase,
        private readonly findOverrideCountsByRepositoryPullRequestMessagesUseCase: FindOverrideCountsByRepositoryPullRequestMessagesUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/')
    @ApiOperation({
        summary: 'Create or update PR messages',
        description:
            'Creates or updates the review message configuration for a repository or directory.',
    })
    @ApiBody({ type: PullRequestMessagesUpsertDto })
    @ApiOkResponse({ description: 'Configuration updated or PR proposed' })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    public async createOrUpdatePullRequestMessages(
        @Body() body: PullRequestMessagesUpsertDto,
    ) {
        const { teamId, ...payload } = body;

        return await this.createOrUpdatePullRequestMessagesUseCase.execute(
            this.request.user,
            payload as unknown as IPullRequestMessages,
            {
                teamId,
            },
        );
    }

    @Get('/find-by-repository-or-directory')
    @ApiOperation({
        summary: 'Get PR messages by repository or directory',
        description:
            'Returns the resolved message configuration for the specified repository or directory.',
    })
    @ApiQuery({ name: 'repositoryId', required: true })
    @ApiQuery({ name: 'directoryId', required: false })
    @ApiOkResponse({ type: PullRequestMessagesResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
            repo: {
                key: {
                    query: 'repositoryId',
                },
            },
        }),
    )
    public async findByRepoOrDirectoryId(
        @Query('repositoryId') repositoryId: string,
        @Query('directoryId') directoryId?: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.findByRepositoryOrDirectoryIdPullRequestMessagesUseCase.execute(
            organizationId,
            repositoryId,
            directoryId,
        );
    }

    @Get('/override-counts-by-repository')
    @ApiOperation({
        summary:
            'Get custom message override counts for repository and directories',
        description:
            'Returns repository-level and per-directory override counts for custom messages with a single request.',
    })
    @ApiQuery({ name: 'repositoryId', required: true })
    @ApiOkResponse({ type: PullRequestMessagesOverrideCountsResponseDto })
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
            repo: {
                key: {
                    query: 'repositoryId',
                },
            },
        }),
    )
    public async findOverrideCountsByRepository(
        @Query('repositoryId') repositoryId: string,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }

        return await this.findOverrideCountsByRepositoryPullRequestMessagesUseCase.execute(
            organizationId,
            repositoryId,
        );
    }
}
