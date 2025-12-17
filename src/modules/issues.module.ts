import { GenerateIssuesFromPrClosedUseCase } from '@/core/application/use-cases/issues/generate-issues-from-pr-closed.use-case';
import { GetIssueByIdUseCase } from '@/core/application/use-cases/issues/get-issue-by-id.use-case';
import { GetIssuesUseCase } from '@/core/application/use-cases/issues/get-issues.use-case';
import { GetTotalIssuesUseCase } from '@/core/application/use-cases/issues/get-total-issues.use-case';
import { UpdateIssuePropertyUseCase } from '@/core/application/use-cases/issues/update-issue-property.use-case';
import { KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/KodyIssuesManagement.contract';
import { ISSUES_REPOSITORY_TOKEN } from '@/core/domain/issues/contracts/issues.repository';
import { ISSUES_SERVICE_TOKEN } from '@/core/domain/issues/contracts/issues.service.contract';
import { IssuesRepository } from '@/core/infrastructure/adapters/repositories/mongoose/issues.repository';
import {
    IssuesModel,
    IssuesSchema,
} from '@/core/infrastructure/adapters/repositories/mongoose/schema/issues.model';
import { IssuesService } from '@/core/infrastructure/adapters/services/issues/issues.service';
import { KodyIssuesManagementService } from '@/core/infrastructure/adapters/services/kodyIssuesManagement/service/kodyIssuesManagement.service';
import { IssuesController } from '@/core/infrastructure/http/controllers/issues.controller';
import {
    KODY_ISSUES_ANALYSIS_SERVICE_TOKEN,
    KodyIssuesAnalysisService,
} from '@/ee/codeBase/kodyIssuesAnalysis.service';
import { LicenseModule } from '@/ee/license/license.module';
import { PermissionValidationModule } from '@/ee/shared/permission-validation.module';
import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GlobalCacheModule } from './cache.module';
import { CodebaseModule } from './codeBase.module';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { OrganizationModule } from './organization.module';
import { OrganizationParametersModule } from './organizationParameters.module';
import { ParametersModule } from './parameters.module';
import { PullRequestsModule } from './pullRequests.module';
import { UsersModule } from './user.module';
import { KodyRulesModule } from './kodyRules.module';

const UseCases = [
    UpdateIssuePropertyUseCase,
    GenerateIssuesFromPrClosedUseCase,
    GetTotalIssuesUseCase,
    GetIssuesUseCase,
    GetIssueByIdUseCase,
] as const;

@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: IssuesModel.name,
                schema: IssuesSchema,
            },
        ]),
        forwardRef(() => PullRequestsModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => UsersModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => KodyRulesModule),
        GlobalCacheModule,
        forwardRef(() => LicenseModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => PermissionValidationModule),
    ],
    providers: [
        ...UseCases,

        {
            provide: ISSUES_REPOSITORY_TOKEN,
            useClass: IssuesRepository,
        },
        {
            provide: ISSUES_SERVICE_TOKEN,
            useClass: IssuesService,
        },
        {
            provide: KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN,
            useClass: KodyIssuesManagementService,
        },
        {
            provide: KODY_ISSUES_ANALYSIS_SERVICE_TOKEN,
            useClass: KodyIssuesAnalysisService,
        },
    ],
    controllers: [IssuesController],
    exports: [
        ISSUES_REPOSITORY_TOKEN,
        ISSUES_SERVICE_TOKEN,
        KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN,
        KODY_ISSUES_ANALYSIS_SERVICE_TOKEN,
        ...UseCases,
    ],
})
export class IssuesModule {}
