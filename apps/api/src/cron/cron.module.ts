import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodeReviewConfigurationModule } from '@libs/code-review/modules/code-review-configuration.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { PullRequestsModule } from '@libs/code-review/modules/pull-requests.module';
import { PullRequestMessagesModule } from '@libs/code-review/modules/pullRequestMessages.module';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { IntegrationModule } from '@libs/integrations/modules/integrations.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { CliReviewModule } from '@libs/cli-review/cli-review.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { forwardRef, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { CheckIfPRCanBeApprovedCronProvider } from './CheckIfPRCanBeApproved.cron';
import { ClassifyOrphanedSessionsCronProvider } from './classifyOrphanedSessions.cron';
import { CodeReviewFeedbackCronProvider } from './codeReviewFeedback.cron';
import { KodyLearningCronProvider } from './kodyLearning.cron';
import { SSOTestSessionCleanupCronProvider } from './ssoTestSessionCleanup.cron';
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
        PullRequestMessagesModule,
        forwardRef(() => KodyRulesModule),
        forwardRef(() => CodebaseModule),
        IntegrationModule,
        IntegrationConfigModule,
        forwardRef(() => CliReviewModule),
        forwardRef(() => SSOModule),
    ],
    providers: [
        CheckIfPRCanBeApprovedCronProvider,
        ClassifyOrphanedSessionsCronProvider,
        CodeReviewFeedbackCronProvider,
        KodyLearningCronProvider,
        SSOTestSessionCleanupCronProvider,
        DistributedLockService,
    ],
})
export class CronModule {}
