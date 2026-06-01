import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PullRequestState } from '@libs/core/domain/enums';
import { GetCodeManagementMemberListUseCase } from '@libs/platform/application/use-cases/codeManagement/get-code-management-members-list.use-case';
import { CreateIntegrationUseCase } from '@libs/platform/application/use-cases/codeManagement/create-integration.use-case';
import { CreateRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/create-repositories';
import { GetRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/get-repositories';
import { GetSelectedRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/get-selected-repositories.use-case';
import { GetPRsUseCase } from '@libs/platform/application/use-cases/codeManagement/get-prs.use-case';
import { FinishOnboardingUseCase } from '@libs/platform/application/use-cases/codeManagement/finish-onboarding.use-case';
import { DeleteIntegrationUseCase } from '@libs/platform/application/use-cases/codeManagement/delete-integration.use-case';
import { DeleteIntegrationAndRepositoriesUseCase } from '@libs/platform/application/use-cases/codeManagement/delete-integration-and-repositories.use-case';
import { GetRepositoryTreeByDirectoryUseCase } from '@libs/platform/application/use-cases/codeManagement/get-repository-tree-by-directory.use-case';
import { GetPRsByRepoUseCase } from '@libs/platform/application/use-cases/codeManagement/get-prs-repo.use-case';
import { GetWebhookStatusUseCase } from '@libs/platform/application/use-cases/codeManagement/get-webhook-status.use-case';
import { SearchCodeManagementUsersUseCase } from '@libs/platform/application/use-cases/codeManagement/search-code-management-users.use-case';
import { GetCurrentCodeManagementUserUseCase } from '@libs/platform/application/use-cases/codeManagement/get-current-code-management-user.use-case';
import { FinishOnboardingDTO } from '@libs/platform/dtos/finish-onboarding.dto';
import { GetRepositoryTreeByDirectoryDto } from '@libs/platform/dtos/get-repository-tree-by-directory.dto';
import { WebhookStatusQueryDto } from '../dtos/webhook-status-query.dto';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiNoContentResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ApiArrayResponseDto } from '../dtos/api-response.dto';
import {
    CodeManagementPullRequestsResponseDto,
    CodeManagementRepositoriesCreateResponseDto,
    CodeManagementRepositoriesResponseDto,
    CodeManagementSearchUsersResponseDto,
    CodeManagementCurrentUserResponseDto,
    CodeManagementRepositoryTreeResponseDto,
    CodeManagementWebhookStatusResponseDto,
} from '../dtos/code-management.response.dto';
@ApiTags('Code Management')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('code-management')
export class CodeManagementController {
    constructor(
        private readonly getCodeManagementMemberListUseCase: GetCodeManagementMemberListUseCase,
        private readonly createIntegrationUseCase: CreateIntegrationUseCase,
        private readonly createRepositoriesUseCase: CreateRepositoriesUseCase,
        private readonly getRepositoriesUseCase: GetRepositoriesUseCase,
        private readonly getSelectedRepositoriesUseCase: GetSelectedRepositoriesUseCase,
        private readonly getPRsUseCase: GetPRsUseCase,
        private readonly finishOnboardingUseCase: FinishOnboardingUseCase,
        private readonly deleteIntegrationUseCase: DeleteIntegrationUseCase,
        private readonly deleteIntegrationAndRepositoriesUseCase: DeleteIntegrationAndRepositoriesUseCase,
        private readonly getRepositoryTreeByDirectoryUseCase: GetRepositoryTreeByDirectoryUseCase,
        private readonly getPRsByRepoUseCase: GetPRsByRepoUseCase,
        private readonly getWebhookStatusUseCase: GetWebhookStatusUseCase,
        private readonly searchCodeManagementUsersUseCase: SearchCodeManagementUsersUseCase,
        private readonly getCurrentCodeManagementUserUseCase: GetCurrentCodeManagementUserUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Get('/repositories/org')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List repositories by organization/team',
        description:
            'Returns repositories available to the team within the selected organization.',
    })
    @ApiQuery({ name: 'teamId', required: true })
    @ApiQuery({
        name: 'organizationSelected',
        required: false,
        description: 'Organization selection filter (provider-specific).',
    })
    @ApiQuery({ name: 'isSelected', required: false, type: Boolean })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'perPage', required: false, type: Number })
    @ApiOkResponse({ type: CodeManagementRepositoriesResponseDto })
    public async getRepositories(
        @Query()
        query: {
            teamId: string;
            organizationSelected: any;
            isSelected?: boolean;
            page?: number;
            perPage?: number;
        },
    ) {
        return this.getRepositoriesUseCase.execute(query);
    }

    @Get('/repositories/selected')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'List selected repositories',
        description: 'Returns repositories explicitly selected for the team.',
    })
    @ApiQuery({ name: 'teamId', required: true })
    @ApiQuery({ name: 'page', required: false, type: Number })
    @ApiQuery({ name: 'perPage', required: false, type: Number })
    @ApiOkResponse({ type: CodeManagementRepositoriesResponseDto })
    public async getSelectedRepositories(
        @Query()
        query: {
            teamId: string;
            page?: number;
            perPage?: number;
        },
    ) {
        return this.getSelectedRepositoriesUseCase.execute(query);
    }

    @Post('/auth-integration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Authorize integration',
        description:
            'Creates or updates a code management integration. For GitHub this is driven by the OAuth flow or a token-based integration.',
    })
    public async authIntegrationToken(@Body() body: any) {
        return this.createIntegrationUseCase.execute(body);
    }

    @Post('/repositories')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Create repositories',
        description:
            'Creates or updates repositories for a team (replace or append).',
    })
    @ApiCreatedResponse({ type: CodeManagementRepositoriesCreateResponseDto })
    public async createRepositories(
        @Body()
        body: {
            repositories: Repository[];
            teamId: string;
            type?: 'replace' | 'append';
        },
    ) {
        return this.createRepositoriesUseCase.execute(body);
    }

    @Get('/organization-members')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'List organization members',
        description: 'Returns members from the connected code platform.',
    })
    @ApiQuery({ name: 'teamId', required: true })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async getOrganizationMembers(@Query() query: { teamId: string }) {
        return this.getCodeManagementMemberListUseCase.execute(query.teamId);
    }

    @Post('/organization-members/refresh')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Refresh organization members',
        description:
            'Clears the cached members list and re-fetches from the code platform.',
    })
    @ApiQuery({ name: 'teamId', required: true })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async refreshOrganizationMembers(
        @Query() query: { teamId: string },
    ) {
        return this.getCodeManagementMemberListUseCase.refreshMembers(
            query.teamId,
        );
    }

    @Get('/get-prs')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'List pull requests',
        description:
            'Returns pull requests for the team with optional filters.',
    })
    @ApiQuery({ name: 'teamId', required: true })
    @ApiQuery({ name: 'number', required: false, type: Number })
    @ApiQuery({ name: 'title', required: false })
    @ApiQuery({ name: 'url', required: false })
    @ApiQuery({ name: 'repositoryId', required: false })
    @ApiQuery({ name: 'repositoryName', required: false })
    @ApiQuery({ name: 'repository', required: false })
    @ApiOkResponse({ type: CodeManagementPullRequestsResponseDto })
    public async getPRs(
        @Query()
        query: {
            teamId: string;
            number?: number;
            title?: string;
            url?: string;
            repositoryId?: string;
            repositoryName?: string;
            repository?: string;
        },
    ) {
        return await this.getPRsUseCase.execute({
            teamId: query.teamId,
            number: query.number,
            title: query.title,
            url: query.url,
            repositoryId: query.repositoryId,
            repositoryName: query.repositoryName,
            repository: query.repository,
        });
    }

    @Get('/get-prs-repo')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    @ApiOperation({
        summary: 'List pull requests by repository',
        description:
            'Returns pull requests for a repository with filter options.',
    })
    @ApiQuery({ name: 'teamId', required: true })
    @ApiQuery({ name: 'repositoryId', required: true })
    @ApiQuery({ name: 'number', required: false, type: Number })
    @ApiQuery({ name: 'startDate', required: false })
    @ApiQuery({ name: 'endDate', required: false })
    @ApiQuery({ name: 'author', required: false })
    @ApiQuery({ name: 'branch', required: false })
    @ApiQuery({ name: 'title', required: false })
    @ApiQuery({ name: 'state', required: false })
    @ApiOkResponse({ type: CodeManagementPullRequestsResponseDto })
    public async getPRsByRepo(
        @Query()
        query: {
            teamId: string;
            repositoryId: string;
            number?: number;
            startDate?: string;
            endDate?: string;
            author?: string;
            branch?: string;
            title?: string;
            state?: PullRequestState;
        },
    ) {
        const { teamId, repositoryId, ...filters } = query;
        return await this.getPRsByRepoUseCase.execute({
            teamId,
            repositoryId,
            filters,
        });
    }

    @Post('/finish-onboarding')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.CodeReviewSettings,
        }),
    )
    @ApiOperation({
        summary: 'Finish onboarding',
        description: 'Completes onboarding by running a review setup flow.',
    })
    @ApiNoContentResponse({ description: 'Onboarding completed' })
    public async onboardingReviewPR(
        @Body()
        body: FinishOnboardingDTO,
    ) {
        return await this.finishOnboardingUseCase.execute(body);
    }

    @Delete('/delete-integration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Delete,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Delete integration',
        description: 'Removes a code management integration for the team.',
    })
    @ApiNoContentResponse({ description: 'Integration deleted' })
    public async deleteIntegration(@Query() query: { teamId: string }) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }

        return await this.deleteIntegrationUseCase.execute({
            organizationId,
            teamId: query.teamId,
        });
    }

    @Delete('/delete-integration-and-repositories')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Delete,
            resource: ResourceType.GitSettings,
        }),
    )
    @ApiOperation({
        summary: 'Delete integration and repositories',
        description:
            'Removes integration and associated repositories for the team.',
    })
    @ApiNoContentResponse({
        description: 'Integration and repositories deleted',
    })
    public async deleteIntegrationAndRepositories(
        @Query() query: { teamId: string },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }

        return await this.deleteIntegrationAndRepositoriesUseCase.execute({
            organizationId,
            teamId: query.teamId,
        });
    }

    @Get('/get-repository-tree-by-directory')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkRepoPermissions({
            action: Action.Read,
            resource: ResourceType.CodeReviewSettings,
            repo: {
                key: { query: 'repositoryId' },
            },
        }),
    )
    @ApiOperation({
        summary: 'Get repository tree',
        description:
            'Returns the directory tree for a repository starting from a path.',
    })
    @ApiOkResponse({ type: CodeManagementRepositoryTreeResponseDto })
    public async getRepositoryTreeByDirectory(
        @Query() query: GetRepositoryTreeByDirectoryDto,
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new BadRequestException(
                'organizationId not found in request',
            );
        }

        return await this.getRepositoryTreeByDirectoryUseCase.execute({
            ...query,
            organizationId,
        });
    }

    @Get('/search-users')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Search users',
        description: 'Searches users in the code management platform by query.',
    })
    @ApiQuery({ name: 'organizationId', required: true })
    @ApiQuery({ name: 'teamId', required: false })
    @ApiQuery({ name: 'q', required: false, description: 'Search query.' })
    @ApiQuery({ name: 'userId', required: false })
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiOkResponse({ type: CodeManagementSearchUsersResponseDto })
    public async searchUsers(
        @Query()
        query: {
            organizationId: string;
            teamId?: string;
            q?: string;
            userId?: string;
            limit?: number;
        },
    ) {
        return await this.searchCodeManagementUsersUseCase.execute({
            organizationId: query.organizationId,
            teamId: query.teamId,
            query: query.q,
            userId: query.userId,
            limit: query.limit ? Number(query.limit) : undefined,
        });
    }

    @Get('/current-user')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Get current user',
        description:
            'Returns the current authenticated user in the code management platform.',
    })
    @ApiQuery({ name: 'organizationId', required: true })
    @ApiQuery({ name: 'teamId', required: false })
    @ApiOkResponse({ type: CodeManagementCurrentUserResponseDto })
    public async getCurrentUser(
        @Query()
        query: {
            organizationId: string;
            teamId?: string;
        },
    ) {
        return await this.getCurrentCodeManagementUserUseCase.execute({
            organizationId: query.organizationId,
            teamId: query.teamId,
        });
    }

    // NOT USED IN WEB - INTERNAL USE ONLY
    @Get('/webhook-status')
    @ApiOperation({
        summary: 'Get webhook status',
        description: 'Checks if the repository webhook is active.',
    })
    @ApiOkResponse({ type: CodeManagementWebhookStatusResponseDto })
    public async getWebhookStatus(
        @Query() query: WebhookStatusQueryDto,
    ): Promise<{ active: boolean }> {
        return this.getWebhookStatusUseCase.execute({
            organizationAndTeamData: {
                organizationId: query.organizationId,
                teamId: query.teamId,
            },
            repositoryId: query.repositoryId,
        });
    }
}
