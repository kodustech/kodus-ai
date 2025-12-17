import { UserRequest } from '@/config/types/http/user-request.type';
import { CreateIntegrationUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/create-integration.use-case';
import { CreateRepositoriesUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/create-repositories';
import { DeleteIntegrationAndRepositoriesUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/delete-integration-and-repositories.use-case';
import { DeleteIntegrationUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/delete-integration.use-case';
import { FinishOnboardingUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/finish-onboarding.use-case';
import { GetCodeManagementMemberListUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-code-management-members-list.use-case';
import { GetPRsByRepoUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-prs-repo.use-case';
import { GetPRsUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-prs.use-case';
import { GetRepositoriesUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-repositories';
import { GetRepositoryTreeByDirectoryUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-repository-tree-by-directory.use-case';
import { GetWebhookStatusUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-webhook-status.use-case';
import { GetCurrentCodeManagementUserUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-current-code-management-user.use-case';
import { SearchCodeManagementUsersUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/search-code-management-users.use-case';
import { Repository } from '@/core/domain/integrationConfigs/types/codeManagement/repositories.type';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@/core/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@/core/infrastructure/adapters/services/permissions/policy.handlers';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
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
import { FinishOnboardingDTO } from '../../dtos/finish-onboarding.dto';
import { GetRepositoryTreeByDirectoryDto } from '../../dtos/get-repository-tree-by-directory.dto';
import { WebhookStatusQueryDto } from '../../dtos/webhook-status-query.dto';

@Controller('code-management')
export class CodeManagementController {
    constructor(
        private readonly getCodeManagementMemberListUseCase: GetCodeManagementMemberListUseCase,
        private readonly createIntegrationUseCase: CreateIntegrationUseCase,
        private readonly createRepositoriesUseCase: CreateRepositoriesUseCase,
        private readonly getRepositoriesUseCase: GetRepositoriesUseCase,
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

    @Post('/auth-integration')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.GitSettings,
        }),
    )
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
    public async getOrganizationMembers() {
        return this.getCodeManagementMemberListUseCase.execute();
    }

    @Get('/get-prs')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.PullRequests,
        }),
    )
    public async getPRs(
        @Query()
        query: {
            teamId: string;
            number?: number;
            title: string;
            url?: string;
        },
    ) {
        return await this.getPRsUseCase.execute({
            teamId: query.teamId,
            number: query.number,
            title: query.title,
            url: query.url,
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
