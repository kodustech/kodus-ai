import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { GitlabController } from '@/core/infrastructure/http/controllers/gitlab.controller';
import { forwardRef, Module } from '@nestjs/common';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { AutomationModule } from './automation.module';
import { TeamAutomationModule } from './teamAutomation.module';
import { AutomationStrategyModule } from './automationStrategy.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { TeamsModule } from './team.module';
import { OrganizationModule } from './organization.module';
import { UsersModule } from './user.module';
import { MetricsModule } from './metrics.module';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { ParametersModule } from './parameters.module';
import { GlobalCacheModule } from './cache.module';
import { RunCodeReviewAutomationUseCase } from '@/core/application/use-cases/automation/runCodeReview.use-case';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { CodebaseModule } from './codeBase.module';

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
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => CodebaseModule),
    ],
    providers: [RunCodeReviewAutomationUseCase, PromptService],
    controllers: [GitlabController],
})
export class GitlabModule { }
