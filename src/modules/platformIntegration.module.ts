import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { JiraModule } from './jira.module';
import { GithubModule } from './github.module';
import { ICodeManagementService } from '@/core/domain/platformIntegrations/interfaces/code-management.interface';
import { IProjectManagementService } from '@/core/domain/platformIntegrations/interfaces/project-management.interface';
import { PlatformIntegrationFactory } from '@/core/infrastructure/adapters/services/platformIntegration/platformIntegration.factory';
import { IntegrationModule } from './integration.module';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { ICommunicationService } from '@/core/domain/platformIntegrations/interfaces/communication.interface';
import { IntegrationConfigModule } from './integrationConfig.module';
import { AuthIntegrationModule } from './authIntegration.module';
import { CodeManagementController } from '@/core/infrastructure/http/controllers/platformIntegration/codeManagement.controller';
import { UseCases } from '@/core/application/use-cases/platformIntegration';
import { ProjectManagementController } from '@/core/infrastructure/http/controllers/platformIntegration/projectManagement.controller';
import { CommunicationController } from '@/core/infrastructure/http/controllers/platformIntegration/communication.controller';
import { MSTeamsService } from '@/core/infrastructure/adapters/services/msTeams.service';
import { GitlabService } from '@/core/infrastructure/adapters/services/gitlab.service';
import { TeamMembersModule } from './teamMembers.module';
import { DiscordService } from '@/core/infrastructure/adapters/services/discord.service';
import { AzureBoardsService } from '@/core/infrastructure/adapters/services/azureBoards.service';
import { TeamsModule } from './team.module';
import { CheckinHistoryModule } from './checkinHistory.module';
import { ProfileConfigModule } from './profileConfig.module';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { ParametersModule } from './parameters.module';
import { MetricsModule } from './metrics.module';
import { CheckinHistoryOrganizationModule } from './checkInHistoryOrganization.module';
import { GitlabModule } from './gitlab.module';
import { AgentModule } from './agent.module';
import { AutomationModule } from './automation.module';
import { ReceiveWebhookUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/receiveWebhook.use-case';
import { TeamAutomationModule } from './teamAutomation.module';
import { FinishProjectConfigUseCase } from '@/core/application/use-cases/platformIntegration/projectManagement/finish-project-config.use-case';
import { OrganizationMetricsModule } from './organizationMetrics.module';
import { OrganizationParametersModule } from './organizationParameters.module';
import { OrganizationArtifactsModule } from './organizationArtifacts.module';
import { TeamArtifactsModule } from './teamArtifacts.module';
import { GenerateCodeArtifactsUseCase } from '@/core/application/use-cases/platformIntegration/codeManagement/generate-code-artifacts.use-case';
import { SaveArtifactsStructureUseCase } from '@/core/application/use-cases/parameters/save-artifacts-structure.use-case';
import { CodeReviewFeedbackModule } from './codeReviewFeedback.module';
import { PullRequestsModule } from './pullRequests.module';
import { CodebaseModule } from './codeBase.module';
import { KodyRulesModule } from './kodyRules.module';
import { BitbucketService } from '@/core/infrastructure/adapters/services/bitbucket/bitbucket.service';
import { AzureReposModule } from './azureRepos.module';
@Module({
    imports: [
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => JiraModule),
        forwardRef(() => GithubModule),
        forwardRef(() => GitlabModule),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => CheckinHistoryModule),
        forwardRef(() => CheckinHistoryOrganizationModule),
        forwardRef(() => AgentModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => TeamAutomationModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => TeamArtifactsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationMetricsModule),
        forwardRef(() => OrganizationArtifactsModule),
        forwardRef(() => OrganizationParametersModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => KodyRulesModule),
        forwardRef(() => AzureReposModule),
        PullRequestsModule,
    ],
    providers: [
        ...UseCases,
        GenerateCodeArtifactsUseCase,
        SaveArtifactsStructureUseCase,
        PromptService,
        PlatformIntegrationFactory,
        CodeManagementService,
        ProjectManagementService,
        CommunicationService,

        //Integrations tools
        MSTeamsService,
        GitlabService,
        DiscordService,
        AzureBoardsService,
        BitbucketService,
    ],
    controllers: [
        CodeManagementController,
        ProjectManagementController,
        CommunicationController,
    ],
    exports: [
        PlatformIntegrationFactory,
        CodeManagementService,
        ProjectManagementService,
        CommunicationService,
        ReceiveWebhookUseCase,
        FinishProjectConfigUseCase,
    ],
})
export class PlatformIntegrationModule implements OnModuleInit {
    constructor(
        private modulesContainer: ModulesContainer,
        private integrationFactory: PlatformIntegrationFactory,
    ) { }

    onModuleInit() {
        const providers = [...this.modulesContainer.values()]
            .map((module) => module.providers)
            .reduce((acc, map) => [...acc, ...map.values()], [])
            .filter((provider) => provider.instance);

        providers.forEach((provider) => {
            const { instance } = provider;
            const integrationMetadata = Reflect.getMetadata(
                'integration',
                instance.constructor,
            );

            if (integrationMetadata) {
                const { type, serviceType } = integrationMetadata;
                if (serviceType === 'codeManagement') {
                    this.integrationFactory.registerCodeManagementService(
                        type,
                        instance as ICodeManagementService,
                    );
                } else if (serviceType === 'projectManagement') {
                    this.integrationFactory.registerProjectManagementService(
                        type,
                        instance as IProjectManagementService,
                    );
                } else if (serviceType === 'communication') {
                    this.integrationFactory.registerCommunicationService(
                        type,
                        instance as ICommunicationService,
                    );
                }
            }
        });
    }
}
