import { Module, forwardRef } from '@nestjs/common';
import { SLACK_SERVICE_TOKEN } from '@/core/domain/slack/contracts/slack.service.contract';
import { UsersModule } from '@/modules/user.module';
import { ProfilesModule } from '@/modules/profiles.module';
import { TeamMembersModule } from './teamMembers.module';
import { JiraModule } from './jira.module';
import { AgentModule } from './agent.module';
import { SlackService } from '@/core/infrastructure/adapters/services/slack/slack.service';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { CheckinHistoryModule } from './checkinHistory.module';
import { ProfileConfigModule } from './profileConfig.module';
import { CheckinHistoryOrganizationModule } from './checkInHistoryOrganization.module';
import { AutomationModule } from './automation.module';
import { TeamAutomationModule } from './teamAutomation.module';

@Module({
    imports: [
        forwardRef(() => TeamMembersModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => JiraModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => UsersModule),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => ProfilesModule),
        forwardRef(() => AgentModule),
        forwardRef(() => CheckinHistoryModule),
        forwardRef(() => CheckinHistoryOrganizationModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => TeamAutomationModule),
    ],
    providers: [
        {
            provide: SLACK_SERVICE_TOKEN,
            useClass: SlackService,
        },
    ],
    exports: [SLACK_SERVICE_TOKEN],
})
export class SlackModule { }
