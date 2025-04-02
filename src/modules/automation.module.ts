import { UseCases } from '@/core/application/use-cases/automation';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AutomationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/automation.model';
import { AUTOMATION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/automation.repository';
import { AUTOMATION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/automation.service';
import { AutomationRepository } from '@/core/infrastructure/adapters/repositories/typeorm/automation.repository';
import { AutomationService } from '@/core/infrastructure/adapters/services/automation/automation.service';
import { AUTOMATION_EXECUTION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/automation-execution.repository';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/automation-execution.service';
import { AutomationExecutionRepository } from '@/core/infrastructure/adapters/repositories/typeorm/automationExecution.repository';
import { AutomationExecutionService } from '@/core/infrastructure/adapters/services/automation/automation-execution.service';
import { AutomationExecutionModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/automationExecution.model';
import { JiraModule } from './jira.module';
import { GithubModule } from './github.module';
import { TeamsModule } from './team.module';
import { Module, forwardRef } from '@nestjs/common';
import { AutomationController } from '@/core/infrastructure/http/controllers/automation.controller';
import { TeamAutomationModule } from './teamAutomation.module';
import { AutomationStrategyModule } from './automationStrategy.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { AUTOMATION_DAILY_CHECKIN_SERVICE_TOKEN } from '@/core/domain/automation/contracts/automation-dailycheckin.service';
import { AutomationDailyCheckinService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationDailyCheckin.service';
import { MetricsModule } from './metrics.module';
import { IntegrationModule } from './integration.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { IntegrationConfigModule } from './integrationConfig.module';
import { CheckinInsightsModule } from './checkinInsights.module';
import { AUTOMATION_WEEKLY_CHECKIN_SERVICE_TOKEN } from '@/core/domain/automation/contracts/automation_weeklyCheckin.service';
import { AutomationTeamProgressService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationTeamProgress.service';
import { CheckinHistoryModule } from './checkinHistory.module';
import { UseCases as EnrichTeamArtifactsUseCase } from '@/core/application/use-cases/teamArtifacts';
import { AuthIntegrationModule } from './authIntegration.module';
import { CheckinHistoryOrganizationModule } from './checkInHistoryOrganization.module';
import { OrganizationAutomationExecutionModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organizationAutomationExecution.model';
import { ORGANIZATION_AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@/core/domain/automation/contracts/organization-automation-execution.service';
import { OrganizationAutomationExecutionService } from '@/core/infrastructure/adapters/services/automation/organization-automation-execution.service';
import { ORGANIZATION_AUTOMATION_EXECUTION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/organization-automation-execution.repository';
import { OrganizationAutomationExecutionRepository } from '@/core/infrastructure/adapters/repositories/typeorm/organizationAutomationExecution.repository';
import { OrganizationAutomationModule } from './organizationAutomation.module';
import { UseCases as OrganizationAutomationUseCases } from '@/core/application/use-cases/organizationAutomation';
import { OrganizationModule } from './organization.module';
import { CheckinModule } from './checkin.module';
import { ParametersModule } from './parameters.module';
import { RunCodeReviewAutomationUseCase } from '@/core/application/use-cases/automation/runCodeReview.use-case';
import { CodebaseModule } from './codeBase.module';
import { UseCases as SaveCodeReviewFeedbackUseCase } from '@/core/application/use-cases/codeReviewFeedback';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { PullRequestsModule } from './pullRequests.module';
import { TeamArtifactsModule } from './teamArtifacts.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            AutomationModel,
            AutomationExecutionModel,
            OrganizationAutomationExecutionModel,
        ]),
        forwardRef(() => TeamsModule),
        forwardRef(() => JiraModule),
        forwardRef(() => GithubModule),
        forwardRef(() => TeamAutomationModule),
        forwardRef(() => OrganizationAutomationModule),
        forwardRef(() => AutomationStrategyModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => CheckinInsightsModule),
        forwardRef(() => CheckinHistoryModule),
        forwardRef(() => CheckinHistoryOrganizationModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => PullRequestsModule),
        AuthIntegrationModule,
        CheckinModule,
        TeamArtifactsModule,
    ],
    providers: [
        ...UseCases,
        ...OrganizationAutomationUseCases,
        ...EnrichTeamArtifactsUseCase,
        ...SaveCodeReviewFeedbackUseCase,
        PromptService,
        {
            provide: AUTOMATION_REPOSITORY_TOKEN,
            useClass: AutomationRepository,
        },
        {
            provide: AUTOMATION_SERVICE_TOKEN,
            useClass: AutomationService,
        },
        {
            provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
            useClass: AutomationExecutionService,
        },
        {
            provide: AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
            useClass: AutomationExecutionRepository,
        },
        {
            provide: ORGANIZATION_AUTOMATION_EXECUTION_SERVICE_TOKEN,
            useClass: OrganizationAutomationExecutionService,
        },
        {
            provide: ORGANIZATION_AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
            useClass: OrganizationAutomationExecutionRepository,
        },
        {
            provide: AUTOMATION_DAILY_CHECKIN_SERVICE_TOKEN,
            useClass: AutomationDailyCheckinService,
        },
        {
            provide: AUTOMATION_WEEKLY_CHECKIN_SERVICE_TOKEN,
            useClass: AutomationTeamProgressService,
        },
    ],
    controllers: [AutomationController],
    exports: [
        AUTOMATION_REPOSITORY_TOKEN,
        AUTOMATION_SERVICE_TOKEN,
        AUTOMATION_EXECUTION_SERVICE_TOKEN,
        AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
        ORGANIZATION_AUTOMATION_EXECUTION_SERVICE_TOKEN,
        ORGANIZATION_AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
        AUTOMATION_DAILY_CHECKIN_SERVICE_TOKEN,
        AUTOMATION_WEEKLY_CHECKIN_SERVICE_TOKEN,
        RunCodeReviewAutomationUseCase,
    ],
})
export class AutomationModule {}
