import { CreateIntegrationUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/create-integration.use-case';
import { CreateRepositoriesUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/create-repositories';
import { GetCodeManagementMemberListUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-code-management-members-list.use-case';
import { GetRepositoriesUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-repositories';
import { VerifyConnectionUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/verify-connection.use-case';
import { Repository } from '@/core/domain/integrationConfigs/types/codeManagement/repositories.type';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TeamQueryDto } from '../../dtos/teamId-query-dto';
import { GetOrganizationUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-organizations.use-case';
import { SaveCodeConfigUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/save-config.use-case';
import { SavePatTokenConfigUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/savePatTokenUseCase';
import { GetPatTokenUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/getPatTokenUseCase';
import { GetWorkflowsUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-workflows-use-case';
import { GetPRsUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-prs.use-case';
import { CreatePRCodeReviewUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/create-prs-code-review.use-case';
import { GetCodeReviewStartedUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/get-code-review-started.use-case';
import { FinishOnboardingDTO } from '../../dtos/finish-onboarding.dto';
import { FinishOnboardingUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/finish-onboarding.use-case';

@Controller('code-management')
export class CodeManagementController {
    constructor(
        private readonly getCodeManagementMemberListUseCase: GetCodeManagementMemberListUseCase,
        private readonly createIntegrationUseCase: CreateIntegrationUseCase,
        private readonly verifyConnectionUseCase: VerifyConnectionUseCase,
        private readonly createRepositoriesUseCase: CreateRepositoriesUseCase,
        private readonly getRepositoriesUseCase: GetRepositoriesUseCase,
        private readonly getOrganizationUseCase: GetOrganizationUseCase,
        private readonly saveCodeConfigUseCase: SaveCodeConfigUseCase,
        private readonly savePatTokenConfigUseCase: SavePatTokenConfigUseCase,
        private readonly getPatTokenUseCase: GetPatTokenUseCase,
        private readonly getWorkflowsUseCase: GetWorkflowsUseCase,
        private readonly getPRsUseCase: GetPRsUseCase,
        private readonly createPRCodeReviewUseCase: CreatePRCodeReviewUseCase,
        private readonly getCodeReviewStartedUseCase: GetCodeReviewStartedUseCase,
        private readonly finishOnboardingUseCase: FinishOnboardingUseCase,
    ) { }

    @Get('/repositories/org')
    public async getRepositories(
        @Query() query: { teamId: string; organizationSelected: any },
    ) {
        return this.getRepositoriesUseCase.execute(query);
    }

    @Get('/verify')
    public async verifyConnection(@Query() query: TeamQueryDto) {
        return this.verifyConnectionUseCase.execute(query.teamId);
    }

    @Post('/auth-integration')
    public async authIntegrationToken(@Body() body: any) {
        return this.createIntegrationUseCase.execute(body);
    }

    // METHOD USED ONLY AZURE REPOS
    @Post('/create-auth-integration')
    public async createIntegrationToken(@Body() body: any) {
        return this.createIntegrationUseCase.execute(body);
    }

    @Post('/repositories')
    public async createRepositories(
        @Body() body: { repositories: Repository[]; teamId: string },
    ) {
        return this.createRepositoriesUseCase.execute(body);
    }

    @Get('/list-members')
    public async getListMembers() {
        return this.getCodeManagementMemberListUseCase.execute();
    }

    @Get('/organizations')
    public async getOrganizations() {
        return this.getOrganizationUseCase.execute();
    }

    @Post('config')
    public async saveSetupConfig(
        @Body()
        body: {
            organizationSelected: any;
            teamId: string;
        },
    ) {
        await this.saveCodeConfigUseCase.execute(body);
    }

    @Post('/save-personal-token')
    public async savePersonalToken(
        @Body()
        body: {
            token: string;
            teamId: string;
        },
    ) {
        return await this.savePatTokenConfigUseCase.execute({
            token: body.token,
            teamId: body.teamId,
        });
    }

    @Get('/get-personal-token')
    public async getPatToken(@Query() query: { teamId: string }) {
        return this.getPatTokenUseCase.execute({ teamId: query.teamId });
    }

    @Get('/get-workflows')
    public async getWorkflows(@Query() query: { teamId: string }) {
        return this.getWorkflowsUseCase.execute({ teamId: query.teamId });
    }

    @Get('/get-prs')
    public async getPRs(@Query() query: { teamId: string }) {
        return await this.getPRsUseCase.execute({ teamId: query.teamId });
    }

    @Get('/get-code-review-started')
    public async GetCodeReviewStarted(@Query() query: { teamId: string }) {
        return await this.getCodeReviewStartedUseCase.execute({
            teamId: query.teamId,
        });
    }

    @Post('/review-pr')
    public async reviewPR(@Body() body: {
        teamId: string;
        payload: {
            id: number;
            repository: string;
            pull_number: number;
        }
    }) {
        return await this.createPRCodeReviewUseCase.execute(body);
    }

    @Post('/finish-onboarding')
    public async onboardingReviewPR(
        @Body()
        body: FinishOnboardingDTO,
    ) {
        return await this.finishOnboardingUseCase.execute(body);
    }
}
