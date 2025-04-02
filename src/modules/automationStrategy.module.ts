import { Module, forwardRef } from '@nestjs/common';
import { AutomationModule } from './automation.module';
import { EXECUTE_AUTOMATION_SERVICE_TOKEN } from '@/shared/domain/contracts/execute.automation.service.contracts';
import { AutomationTeamProgressService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationTeamProgress.service';
import { GithubModule } from './github.module';
import { JiraModule } from './jira.module';
import { SlackModule } from './slack.module';
import { TeamMembersModule } from './teamMembers.module';
import { ExecuteAutomationService } from '@/core/infrastructure/adapters/services/automation/processAutomation/config/execute.automation';
import { AutomationRegistry } from '@/core/infrastructure/adapters/services/automation/processAutomation/config/register.automation';
import { TeamAutomationModule } from './teamAutomation.module';
import { AutomationIssuesDetailsService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationIssuesDetails';
import { AutomationImproveTaskService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationImproveTask';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { MetricsModule } from './metrics.module';
import { TeamsModule } from '@/modules/team.module';
import { AutomationDailyCheckinService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationDailyCheckin.service';
import { CheckinHistoryModule } from './checkinHistory.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { AutomationSprintRetroService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationSprintRetro';
import { SprintModule } from './sprint.module';
import { CheckinInsightsModule } from './checkinInsights.module';
import { OrganizationAutomationModule } from './organizationAutomation.module';
import { AutomationExecutiveCheckin } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationExecutiveCheckin.service';
import { ProfileConfigModule } from './profileConfig.module';
import { UseCases } from '@/core/application/use-cases/automation';
import { UseCases as EnrichTeamArtifactsUseCase } from '@/core/application/use-cases/teamArtifacts';
import { AutomationCodeReviewService } from '@/core/infrastructure/adapters/services/automation/processAutomation/strategies/automationCodeReview';
import { CheckinHistoryOrganizationModule } from './checkInHistoryOrganization.module';
import { ParametersModule } from './parameters.module';
import { CheckinModule } from './checkin.module';
import { GetConnectionsUseCase } from '@/core/application/use-cases/integrations/get-connections.use-case';
import { CodebaseModule } from './codeBase.module';
import { UseCases as SaveCodeReviewFeedbackUseCase } from '@/core/application/use-cases/codeReviewFeedback';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { OrganizationModule } from './organization.module';
import { PullRequestsModule } from './pullRequests.module';
import { TeamArtifactsModule } from './teamArtifacts.module';

@Module({
    imports: [
        forwardRef(() => JiraModule),
        forwardRef(() => GithubModule),
        forwardRef(() => SlackModule),
        forwardRef(() => TeamAutomationModule),
        forwardRef(() => OrganizationAutomationModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => SprintModule),
        forwardRef(() => CheckinInsightsModule),
        forwardRef(() => TeamArtifactsModule),
        forwardRef(() => SprintModule),
        forwardRef(() => CheckinInsightsModule),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => CheckinModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => PullRequestsModule),
        CheckinHistoryOrganizationModule,
        AuthIntegrationModule,
        CheckinHistoryModule,
    ],
    providers: [
        ...UseCases,
        ...EnrichTeamArtifactsUseCase,
        ...SaveCodeReviewFeedbackUseCase,
        GetConnectionsUseCase,
        AutomationTeamProgressService,
        AutomationImproveTaskService,
        AutomationIssuesDetailsService,
        AutomationDailyCheckinService,
        AutomationSprintRetroService,
        AutomationCodeReviewService,
        AutomationExecutiveCheckin,
        PromptService,
        {
            provide: EXECUTE_AUTOMATION_SERVICE_TOKEN,
            useClass: ExecuteAutomationService,
        },
        {
            provide: 'STRATEGIES_AUTOMATION',
            useFactory: (
                teamProgressService: AutomationTeamProgressService,
                improveTaskService: AutomationImproveTaskService,
                automationIssuesDetailsService: AutomationIssuesDetailsService,
                automationDailyCheckinService: AutomationDailyCheckinService,
                automationSprintRetroService: AutomationSprintRetroService,
                automationCodeReviewService: AutomationCodeReviewService,
                automationExecutiveCheckin: AutomationExecutiveCheckin,
            ) => {
                return [
                    teamProgressService,
                    improveTaskService,
                    automationIssuesDetailsService,
                    automationDailyCheckinService,
                    automationSprintRetroService,
                    automationCodeReviewService,
                    automationExecutiveCheckin,
                ];
            },
            inject: [
                AutomationTeamProgressService,
                AutomationImproveTaskService,
                AutomationIssuesDetailsService,
                AutomationDailyCheckinService,
                AutomationSprintRetroService,
                AutomationCodeReviewService,
                AutomationExecutiveCheckin,
            ],
        },
        AutomationRegistry,
    ],
    exports: [
        'STRATEGIES_AUTOMATION',
        EXECUTE_AUTOMATION_SERVICE_TOKEN,
        AutomationRegistry,
    ],
})
export class AutomationStrategyModule {}
