import { GithubModule } from '@/modules/github.module';
import { JiraModule } from '@/modules/jira.module';
import { SlackModule } from '@/modules/slack.module';
import { UsersModule } from '@/modules/user.module';
import { SentryModule } from '@sentry/nestjs/setup';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database.module';
import { OrganizationModule } from './organization.module';
import { SharedModule } from './shared.module';
import { MessageModule } from './message.module';
import { HealthModule } from './health.module';
import { TeamMembersModule } from './teamMembers.module';
import { AuthModule } from './auth.module';
import { JwtAuthGuard } from '@/core/infrastructure/adapters/services/auth/jwt-auth.guard';
import { APP_GUARD } from '@nestjs/core';
import { ProfilesModule } from '@/modules/profiles.module';
import { TeamsModule } from './team.module';
import { CronModule } from './cron.module';
import { MetricsModule } from './metrics.module';
import { AutomationModule } from './automation.module';
import { TeamAutomationModule } from './teamAutomation.module';
import { ScheduleModule } from '@nestjs/schedule';
import { AutomationStrategyModule } from './automationStrategy.module';
import { MemoryModule } from './memory.module';
import { SessionModule } from './session.module';
import { AgentModule } from './agent.module';
import { LoggerModule } from 'nestjs-pino';
import { LogModule } from './log.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { MSTeamsModule } from './msTeams.module';
import { AzureBoardsModule } from './azureBoards.module';
import { CheckinHistoryModule } from './checkinHistory.module';
import { InteractionModule } from '@/modules/interaction.module';
import { ToolsModule } from './tools.module';
import { SprintModule } from './sprint.module';
import { ParametersModule } from './parameters.module';
import { ProfileConfigModule } from './profileConfig.module';
import { OrganizationArtifactsModule } from './organizationArtifacts.module';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { OrganizationParametersModule } from './organizationParameters.module';
import { GlobalCacheModule } from './cache.module';
import { RabbitMQWrapperModule } from './rabbitmq.module';
import { OrganizationAutomationModule } from './organizationAutomation.module';
import { CheckinHistoryOrganizationModule } from './checkInHistoryOrganization.module';
import { CheckinModule } from './checkin.module';
import { SnoozedItemsModule } from './snoozedItems.module';
import { GitlabModule } from './gitlab.module';
import { CodebaseModule } from './codeBase.module';
import { ConversationModule } from './conversation.module';
import { SegmentModule } from './segment.module';
import { KodyRulesModule } from './kodyRules.module';
import { AstModule } from './ast.module';
import { BitbucketModule } from './bitbucket.module';
import { SuggestionEmbeddedModule } from './suggestionEmbedded.module';
import { TeamArtifactsModule } from './teamArtifacts.module';
import { FileReviewModule } from '@/ee/codeReview/fileReviewContextPreparation/fileReview.module';
import { KodyFineTuningContextModule } from '@/ee/kodyFineTuning/fineTuningContext/kodyFineTuningContext.module';
import { KodyASTAnalyzeContextModule } from '@/ee/kodyASTAnalyze/kodyAstAnalyzeContext.module';
import { GlobalParametersModule } from './global-parameters.module';

@Module({
    imports: [
        GlobalCacheModule,
        RabbitMQWrapperModule.register(),
        ScheduleModule.forRoot(),
        LoggerModule.forRoot(),
        ToolsModule.forRoot(),
        SentryModule.forRoot(),
        PlatformIntegrationModule,
        LogModule,
        CronModule,
        DatabaseModule,
        SharedModule,
        AuthModule,
        UsersModule,
        TeamMembersModule,
        GithubModule,
        GitlabModule,
        JiraModule,
        OrganizationModule,
        MessageModule,
        HealthModule,
        ProfilesModule,
        TeamsModule,
        MetricsModule,
        AutomationModule,
        TeamAutomationModule,
        SlackModule,
        CheckinModule,
        AutomationStrategyModule,
        MemoryModule,
        SessionModule,
        AgentModule,
        AuthIntegrationModule,
        IntegrationModule,
        IntegrationConfigModule,
        MSTeamsModule,
        AzureBoardsModule,
        CheckinHistoryModule,
        CheckinHistoryOrganizationModule,
        InteractionModule,
        ProfileConfigModule,
        SprintModule,
        ParametersModule,
        OrganizationParametersModule,
        OrganizationArtifactsModule,
        OrganizationMetricsModule,
        OrganizationAutomationModule,
        SnoozedItemsModule,
        CodebaseModule,
        ConversationModule,
        SegmentModule,
        KodyRulesModule,
        AstModule,
        BitbucketModule,
        SuggestionEmbeddedModule,
        TeamArtifactsModule,
        FileReviewModule,
        KodyFineTuningContextModule,
        KodyASTAnalyzeContextModule,
        GlobalParametersModule,
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
    ],
})
export class AppModule { }
