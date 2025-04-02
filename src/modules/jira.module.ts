import { UseCases } from '@/core/application/use-cases/jira';
import { JIRA_SERVICE_TOKEN } from '@/core/domain/jira/contracts/jira.service.contract';
import { JiraService } from '@/core/infrastructure/adapters/services/jira/jira.service';
import { JiraController } from '@/core/infrastructure/http/controllers/jira.controller';
import { OrganizationModule } from '@/modules/organization.module';
import { Module, forwardRef } from '@nestjs/common';
import { UsersModule } from '@/modules/user.module';
import { HttpModule } from '@nestjs/axios';
import { SlackModule } from './slack.module';
import { GithubModule } from './github.module';
import { TeamsModule } from './team.module';
import { AutomationStrategyModule } from './automationStrategy.module';
import { IntegrationModule } from './integration.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';

import { ParametersModule } from './parameters.module';
import { OrganizationParametersModule } from './organizationParameters.module';
import { AxiosJiraService } from '@/config/axios/microservices/jira.axios';
import { TeamArtifactsModule } from './teamArtifacts.module';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { OrganizationArtifactsModule } from './organizationArtifacts.module';
import { MetricsModule } from './metrics.module';
import { TeamAutomationModule } from './teamAutomation.module';
import { AutomationModule } from './automation.module';

@Module({
    imports: [
        HttpModule,
        forwardRef(() => SlackModule),
        forwardRef(() => GithubModule),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => AutomationStrategyModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => UsersModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => OrganizationMetricsModule),
        forwardRef(() => OrganizationArtifactsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => TeamArtifactsModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => TeamAutomationModule),
    ],
    providers: [
        ...UseCases,
        {
            provide: JIRA_SERVICE_TOKEN,
            useClass: JiraService,
        },
        AxiosJiraService,
    ],
    exports: [JIRA_SERVICE_TOKEN],
    controllers: [JiraController],
})
export class JiraModule {}
