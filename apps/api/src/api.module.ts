import { LLMModule } from '@kodus/kodus-common/llm';
import { AgentsModule } from '@libs/agents/modules/agents.module';
import { AIEngineModule } from '@libs/ai-engine/modules/ai-engine.module';
import { AnalyticsModule } from '@libs/analytics/modules/analytics.module';
import { SpendLimitModule } from '@libs/analytics/modules/spend-limit.module';
import { FeatureGateModule } from '@libs/feature-gate/modules/feature-gate.module';
import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';
import { AnalyticsWarehouseModule } from '@libs/ee/analytics-warehouse';
import { CockpitModule } from '@libs/cockpit/modules/cockpit.module';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CliReviewModule } from '@libs/cli-review/cli-review.module';
import { CodeReviewConfigurationModule } from '@libs/code-review/modules/code-review-configuration.module';
import { CodeReviewDashboardModule } from '@libs/code-review/modules/code-review-dashboard.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { PullRequestsModule } from '@libs/code-review/modules/pull-requests.module';
import { PullRequestMessagesModule } from '@libs/code-review/modules/pullRequestMessages.module';
import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { HealthModule } from '@libs/core/health/health.module';
import { IncidentModule } from '@libs/core/infrastructure/incident/incident.module';
import { MetricsController } from '@libs/core/infrastructure/metrics/metrics.controller';
import { MetricsModule } from '@libs/core/infrastructure/metrics/metrics.module';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { WorkflowModule } from '@libs/core/workflow/modules/workflow.module';
import { DryRunModule } from '@libs/dryRun/dry-run.module';
import { CodeReviewSettingsLogModule } from '@libs/ee/codeReviewSettingsLog/codeReviewSettingsLog.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { SSOModule } from '@libs/ee/sso/sso.module';
import { AuthModule } from '@libs/identity/modules/auth.module';
import { PermissionsModule } from '@libs/identity/modules/permissions.module';
import { UserModule } from '@libs/identity/modules/user.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { IssuesModule } from '@libs/issues/issues.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { GithubIssuesMcpModule } from '@libs/mcp-server/github-issues-mcp.module';
import { McpModule } from '@libs/mcp-server/mcp.module';
import { OrganizationOnboardingModule } from '@libs/organization/modules/organization-onboarding.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { TeamMembersModule } from '@libs/organization/modules/teamMembers.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedCoreModule } from '@libs/shared/infrastructure/shared-core.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { Module } from '@nestjs/common';
import { AgentController } from './controllers/agent.controller';
import { AuthController } from './controllers/auth.controller';
import { CliConfigController } from './controllers/cli/cli-config.controller';
import { CliCentralizedConfigController } from './controllers/cli/cli-centralized-config.controller';
import { CliKodyRulesController } from './controllers/cli/cli-kody-rules.controller';
import { CliAuthController } from './controllers/cli-auth.controller';
import { CliReviewController } from './controllers/cli/cli-review.controller';
import { CliReviewsController } from './controllers/cli-reviews.controller';
import { CodeBaseController } from './controllers/codeBase.controller';
import { CodeManagementController } from './controllers/codeManagement.controller';
import { CodeReviewSettingLogController } from './controllers/codeReviewSettingLog.controller';
import { DryRunController } from './controllers/dryRun.controller';
import { IntegrationController } from './controllers/integration.controller';
import { IntegrationConfigController } from './controllers/integrationConfig.controller';
import { IssuesController } from './controllers/issues.controller';
import { KodyRulesController } from './controllers/kodyRules.controller';
import { LicenseController } from './controllers/license.controller';
import { OrganizationController } from './controllers/organization.controller';
import { TrialExtensionNotifierService } from './services/trial-extension-notifier.service';
import { OrganizationParametersController } from './controllers/organizationParameters.controller';
import { ParametersController } from './controllers/parameters.controller';
import { PermissionsController } from './controllers/permissions.controller';
import {
    CockpitCodeHealthController,
    CockpitController,
    CockpitProductivityController,
    CockpitReviewAnalyticsController,
    CockpitWeeklyRecapController,
} from './controllers/cockpit.controller';
import { PullRequestController } from './controllers/pullRequest.controller';
import { PullRequestMessagesController } from './controllers/pullRequestMessages.controller';
import { RuleLikeController } from './controllers/ruleLike.controller';
import { SkillsController } from './controllers/skills.controller';
import { SSOConfigController } from './controllers/ssoConfig.controller';
import { TeamCliKeyController } from './controllers/team-cli-key.controller';
import { TeamController } from './controllers/team.controller';
import { TeamMembersController } from './controllers/teamMembers.controller';
import { TokenUsageController } from './controllers/tokenUsage.controller';
import { SpendLimitController } from './controllers/spendLimit.controller';
import { UsersController } from './controllers/user.controller';
import { CronModule } from './cron/cron.module';
import { CentralizedConfigModule } from '@libs/centralized-config/modules/centralized-config.module';
import { LangfuseShutdownProvider } from '@libs/core/log/langfuse-shutdown.provider';
import { NotificationModule } from '@libs/notifications/modules/notification.module';
import { NotificationController } from './controllers/notification.controller';

@Module({
    imports: [
        SharedCoreModule,
        SharedConfigModule,
        SharedLogModule,
        SharedObservabilityModule,
        IncidentModule,
        MetricsModule,
        SharedPostgresModule.forRoot({ poolSize: 25 }),
        SharedMongoModule.forRoot(),
        RabbitMQWrapperModule.register({ enableConsumers: false }),
        LLMModule.forRoot({
            logger: LoggerWrapperService,
        }),
        AuthModule,
        UserModule,
        PermissionsModule,
        KodyRulesModule,
        IssuesModule,
        OrganizationModule,
        TeamModule,
        TeamMembersModule,
        OrganizationParametersModule,
        ParametersModule,
        WorkflowModule.register({ type: 'api' }),
        PlatformModule,
        AIEngineModule,
        AgentsModule,
        CodebaseModule,
        PullRequestsModule,
        PullRequestMessagesModule,
        IntegrationModule,
        IntegrationConfigModule,
        DryRunModule,
        AnalyticsModule,
        SpendLimitModule,
        AnalyticsWarehouseModule.forRoot(),
        TelemetryModule,
        FeatureGateModule,
        CockpitModule,
        CodeReviewSettingsLogModule,
        AutomationModule,
        CodeReviewConfigurationModule,
        OrganizationOnboardingModule,
        CodeReviewDashboardModule,
        CliReviewModule,
        PermissionValidationModule,
        LicenseModule,
        McpModule.forRoot(),
        GithubIssuesMcpModule.forRoot(),
        HealthModule,
        CronModule,
        SSOModule,
        GlobalCacheModule,
        CentralizedConfigModule,
        NotificationModule,
    ],
    controllers: [
        CodeManagementController,
        DryRunController,
        CodeReviewSettingLogController,
        PullRequestMessagesController,
        CodeBaseController,
        IssuesController,
        KodyRulesController,
        RuleLikeController,
        OrganizationController,
        ParametersController,
        OrganizationParametersController,
        SkillsController,
        TeamController,
        TeamCliKeyController,
        TeamMembersController,
        AgentController,
        AuthController,
        TokenUsageController,
        SpendLimitController,
        PermissionsController,
        IntegrationController,
        IntegrationConfigController,
        PullRequestController,
        UsersController,
        CliAuthController,
        CliReviewController,
        CliReviewsController,
        CliConfigController,
        CliCentralizedConfigController,
        CliKodyRulesController,
        SSOConfigController,
        LicenseController,
        MetricsController,
        CockpitController,
        CockpitCodeHealthController,
        CockpitProductivityController,
        CockpitReviewAnalyticsController,
        CockpitWeeklyRecapController,
        NotificationController,
    ],
    providers: [LangfuseShutdownProvider, TrialExtensionNotifierService],
})
export class ApiModule {}
