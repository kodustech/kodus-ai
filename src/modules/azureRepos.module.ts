import { OrganizationModule } from '@/modules/organization.module';
import { Module, forwardRef } from '@nestjs/common';
import { UsersModule } from '@/modules/user.module';
import { TeamsModule } from '@/modules/team.module';
import { IntegrationModule } from './integration.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { ParametersModule } from './parameters.module';
import { MetricsModule } from './metrics.module';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { UseCases as SaveOrganizationMetricsToDbUseCase } from '@/core/application/use-cases/organizationMetrics/';
import { GlobalCacheModule } from './cache.module';
import { AutomationModule } from './automation.module';
import { TeamAutomationModule } from './teamAutomation.module';
import { AutomationStrategyModule } from './automationStrategy.module';
import { AgentModule } from './agent.module';
import { RunCodeReviewAutomationUseCase } from '@/core/application/use-cases/automation/runCodeReview.use-case';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { CodebaseModule } from './codeBase.module';
import { AzureReposService } from '@/core/infrastructure/adapters/services/azureRepos.service';
import { AZURE_REPOS_SERVICE_TOKEN } from '@/core/domain/azureRepos/contracts/azure-repos.service.contract';
import { AzureReposRequestHelper } from '@/core/infrastructure/adapters/services/azureRepos/azure-repos-request-helper';
import { AzureReposController } from '@/core/infrastructure/http/controllers/azureRepos.controller';

@Module({
    imports: [
        forwardRef(() => TeamsModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => UsersModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => OrganizationMetricsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => GlobalCacheModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => TeamAutomationModule),
        forwardRef(() => AutomationStrategyModule),
        forwardRef(() => AgentModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => CodebaseModule),
    ],
    providers: [
        ...SaveOrganizationMetricsToDbUseCase,
        RunCodeReviewAutomationUseCase,
        PromptService,
        AzureReposRequestHelper,
        {
            provide: AZURE_REPOS_SERVICE_TOKEN,
            useClass: AzureReposService,
        },
    ],
    exports: [AZURE_REPOS_SERVICE_TOKEN],
    controllers: [AzureReposController],
})
export class AzureReposModule {}
