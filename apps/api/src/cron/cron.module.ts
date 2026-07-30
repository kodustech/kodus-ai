import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodeReviewConfigurationModule } from '@libs/code-review/modules/code-review-configuration.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { PullRequestsModule } from '@libs/code-review/modules/pull-requests.module';
import { PullRequestMessagesModule } from '@libs/code-review/modules/pullRequestMessages.module';
import { ChecksAdapterFactory } from '@libs/core/infrastructure/pipeline/services/checks-adapter.factory';
import { NullChecksAdapter } from '@libs/core/infrastructure/pipeline/services/null-checks.adapter';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { CliReviewModule } from '@libs/cli-review/cli-review.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { GithubModule } from '@libs/platform/modules/github.module';
import { ForgejoModule } from '@libs/platform/modules/forgejo.module';
import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { SpendLimitModule } from '@libs/analytics/modules/spend-limit.module';

import { ForgejoChecksService } from '@libs/platform/infrastructure/adapters/services/forgejo/forgejo-checks.service';
import { GithubChecksService } from '@libs/platform/infrastructure/adapters/services/github/github-checks.service';

import { CheckIfPRCanBeApprovedCronProvider } from './CheckIfPRCanBeApproved.cron';
import { ClassifyOrphanedSessionsCronProvider } from './classifyOrphanedSessions.cron';
import { CodeReviewFeedbackCronProvider } from './codeReviewFeedback.cron';
import { KodyLearningCronProvider } from './kodyLearning.cron';
import { SpendLimitAlertCronProvider } from './spendLimitAlert.cron';
import { SSOTestSessionCleanupCronProvider } from './ssoTestSessionCleanup.cron';
import { StaleReviewWatchdogCronProvider } from './staleReviewWatchdog.cron';
import { SSOModule } from '@libs/ee/sso/sso.module';

@Module({
    imports: [
        ScheduleModule.forRoot(),
        AutomationModule,
        ParametersModule,
        TeamModule,
        PullRequestsModule,
        CodeReviewConfigurationModule,
        PlatformModule,
        GithubModule,
        ForgejoModule,
        PullRequestMessagesModule,
        forwardRef(() => KodyRulesModule),
        forwardRef(() => CodebaseModule),
        IntegrationModule,
        IntegrationConfigModule,
        forwardRef(() => CliReviewModule),
        forwardRef(() => SSOModule),
        SpendLimitModule,
    ],
    providers: [
        CheckIfPRCanBeApprovedCronProvider,
        ClassifyOrphanedSessionsCronProvider,
        CodeReviewFeedbackCronProvider,
        KodyLearningCronProvider,
        SSOTestSessionCleanupCronProvider,
        SpendLimitAlertCronProvider,
        StaleReviewWatchdogCronProvider,
        DistributedLockService,
        // Checks adapters for the stale review watchdog (same registration
        // pattern as code-review-pipeline.module — the factory is not
        // exported by any module).
        GithubChecksService,
        ForgejoChecksService,
        NullChecksAdapter,
        ChecksAdapterFactory,
    ],
})
export class CronModule {}
