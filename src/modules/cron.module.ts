import { Module, forwardRef } from '@nestjs/common';
import { MetricsCronProvider } from '@/core/infrastructure/adapters/services/cron/metrics.cron';
import { MetricsModule } from './metrics.module';
import { TeamsModule } from './team.module';
import { TeamAutomationModule } from './teamAutomation.module';
import { TeamProgressTrackerCronProvider } from '@/core/infrastructure/adapters/services/cron/automation/teamProgressTrackerCron';
import { AutomationStrategyModule } from './automationStrategy.module';
import { AutomationModule } from './automation.module';
import { InteractionMonitorCron } from '@/core/infrastructure/adapters/services/cron/automation/interactionMonitorCron';
import { JiraModule } from '@/modules/jira.module';
import { IntegrationModule } from './integration.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { EnsureTaskDescriptionCron } from '@/core/infrastructure/adapters/services/cron/automation/ensureTaskDescriptionQualityCron';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { DailyCheckinCronProvider } from '@/core/infrastructure/adapters/services/cron/automation/dailyCheckinCron';
import { TeamArtifactsModule } from './teamArtifacts.module';
import { CompileSprintCronProvider } from '@/core/infrastructure/adapters/services/cron/compileSprint.cron';
import { SprintModule } from './sprint.module';
import { CronSprintRetroProvider } from '@/core/infrastructure/adapters/services/cron/automation/sprintRetroCron';
import { OrganizationMetricsCronProvider } from '@/core/infrastructure/adapters/services/cron/organizationMetrics.cron';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { OrganizationModule } from './organization.module';
import { WeeklyTeamArtifactsProvider } from '@/core/infrastructure/adapters/services/cron/artifacts/teamArtifactsWeekly.cron';
import { DailyTeamArtifactsProvider } from '@/core/infrastructure/adapters/services/cron/artifacts/teamArtifactsDaily.cron';
import { WeeklyOrganizationArtifactsProvider } from '@/core/infrastructure/adapters/services/cron/artifacts/organizationArtifactsWeekly.cron';
import { DailyOrganizationArtifactsProvider } from '@/core/infrastructure/adapters/services/cron/artifacts/organizationArtifactsDaily.cron';
import { OrganizationArtifactsModule } from './organizationArtifacts.module';
import { WeeklyEnrichTeamArtifactsProvider } from '@/core/infrastructure/adapters/services/cron/artifacts/enrichTeamArtifactsWeekly.cron';
import { WeeklyExecutiveCheckinCronProvider } from '@/core/infrastructure/adapters/services/cron/automation/weeklyExecutiveCheckinCron';
import { OrganizationAutomationModule } from './organizationAutomation.module';
import { ParametersModule } from './parameters.module';
import { CodeReviewFeedbackCronProvider } from '@/core/infrastructure/adapters/services/cron/codeReviewFeedback.cron';
import { KodyLearningCronProvider } from '@/core/infrastructure/adapters/services/cron/kodyLearning.cron';
import { KodyRulesModule } from './kodyRules.module';
import { PullRequestsModule } from './pullRequests.module';
import { CheckIfPRCanBeApprovedCronProvider } from '@/core/infrastructure/adapters/services/cron/CheckIfPRCanBeApproved.cron';

@Module({
    imports: [
        forwardRef(() => TeamsModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => SprintModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => KodyRulesModule),
        PullRequestsModule,
        OrganizationArtifactsModule,
        JiraModule,
        TeamAutomationModule,
        AutomationModule,
        AutomationStrategyModule,
        AuthIntegrationModule,
        IntegrationModule,
        IntegrationConfigModule,
        TeamArtifactsModule,
        OrganizationMetricsModule,
        OrganizationModule,
        OrganizationAutomationModule,
    ],
    providers: [
        MetricsCronProvider,
        WeeklyTeamArtifactsProvider,
        WeeklyEnrichTeamArtifactsProvider,
        DailyTeamArtifactsProvider,
        WeeklyOrganizationArtifactsProvider,
        DailyOrganizationArtifactsProvider,
        TeamProgressTrackerCronProvider,
        InteractionMonitorCron,
        EnsureTaskDescriptionCron,
        DailyCheckinCronProvider,
        CompileSprintCronProvider,
        CronSprintRetroProvider,
        OrganizationMetricsCronProvider,
        WeeklyExecutiveCheckinCronProvider,
        CodeReviewFeedbackCronProvider,
        KodyLearningCronProvider,
        CheckIfPRCanBeApprovedCronProvider
    ],
    exports: [
        MetricsCronProvider,
        WeeklyTeamArtifactsProvider,
        WeeklyEnrichTeamArtifactsProvider,
        DailyTeamArtifactsProvider,
        TeamProgressTrackerCronProvider,
        InteractionMonitorCron,
        CompileSprintCronProvider,
        CronSprintRetroProvider,
        OrganizationMetricsCronProvider,
        WeeklyExecutiveCheckinCronProvider,
        CodeReviewFeedbackCronProvider,
        CheckIfPRCanBeApprovedCronProvider
    ],
})
export class CronModule { }
