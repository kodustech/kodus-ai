import { Module, forwardRef } from '@nestjs/common';
import { MemoryModule } from './memory.module';
import { HelpWithCodeAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/helpUser/helpWithCode';
import { HelpWithTaskAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/helpUser/helpWithTask';
import { HelpWithPeopleAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/helpUser/helpWithPeople';
import { TeamAutomationModule } from './teamAutomation.module';
import { PromptRouter } from '@/core/infrastructure/adapters/services/agent/config/promptRouter';
import { AutomationModule } from './automation.module';
import { AGENT_EXECUTION_REPOSITORY_TOKEN } from '@/core/domain/agents/contracts/agent-execution.repository.contracts';
import { AGENT_EXECUTION_SERVICE_TOKEN } from '@/core/domain/agents/contracts/agent-execution.service.contracts';
import { AgentExecutionDatabaseRepository } from '@/core/infrastructure/adapters/repositories/mongoose/agentExecution.repository';
import { MongooseModule } from '@nestjs/mongoose';
import { AgentExecutionModelInstance } from '@/core/infrastructure/adapters/repositories/mongoose/schema';
import { ImproveTaskAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/improveTask';
import { DefaultAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/default';
import { SeekClarificationAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/seekClarification';
import { AGENT_SERVICE_TOKEN } from '@/core/domain/agents/contracts/agent.service.contracts';
import { AgentService } from '@/core/infrastructure/adapters/services/agent/agent.service';
import { SessionModule } from './session.module';
import { UseCases } from '@/core/application/use-cases/agent';
import { AgentController } from '@/core/infrastructure/http/controllers/agent.controller';
import { AuthIntegrationModule } from './authIntegration.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { IntegrationModule } from './integration.module';
import { TaskInsightsProvider } from '@/core/infrastructure/adapters/services/agent/agents/taskInsights';
import { MetricsModule } from './metrics.module';
import { TeamMembersModule } from './teamMembers.module';
import { TeamsModule } from './team.module';
import { ProjectInsightsAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/projectInsights';
import { CheckinHistoryModule } from './checkinHistory.module';
import { AgentExecutionService } from '@/core/infrastructure/adapters/services/agent/agentExecution.service';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { ToolsModule } from './tools.module';
import { UsersModule } from './user.module';
import { ProfileConfigModule } from './profileConfig.module';
import { TeamSelectionAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/teamSelection';
import { GenericQueryAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/genericAgent';
import { S3Module } from './amazonS3.module';
import { S3Service } from '@/core/infrastructure/adapters/services/amazonS3.service';
import { CheckinHistoryOrganizationModule } from './checkInHistoryOrganization.module';
import { ParametersModule } from './parameters.module';
import { CodeReviewAgentProvider } from '@/core/infrastructure/adapters/services/agent/agents/codeReview';
import { OrganizationParametersModule } from './organizationParameters.module';

@Module({
    imports: [
        MongooseModule.forFeature([AgentExecutionModelInstance]),
        ToolsModule.forRoot(),
        forwardRef(() => PlatformIntegrationModule),
        forwardRef(() => TeamAutomationModule),
        forwardRef(() => AutomationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => MetricsModule),
        forwardRef(() => TeamMembersModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => CheckinHistoryModule),
        forwardRef(() => CheckinHistoryOrganizationModule),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => UsersModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => SessionModule),
        forwardRef(() => MemoryModule),
        forwardRef(() => S3Module),
        forwardRef(() => ParametersModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        ...UseCases,
        ImproveTaskAgentProvider,
        DefaultAgentProvider,
        HelpWithCodeAgentProvider,
        HelpWithTaskAgentProvider,
        HelpWithPeopleAgentProvider,
        SeekClarificationAgentProvider,
        TaskInsightsProvider,
        ProjectInsightsAgentProvider,
        CodeReviewAgentProvider,
        TeamSelectionAgentProvider,
        GenericQueryAgentProvider,
        PromptService,
        S3Service,
        {
            provide: 'AGENT_STRATEGIES',
            useFactory: (
                improveTaskAgent: ImproveTaskAgentProvider,
                defaultAgent: DefaultAgentProvider,
                helpWithCodeAgent: HelpWithCodeAgentProvider,
                helpWithTaskAgent: HelpWithTaskAgentProvider,
                helpWithPeopleAgent: HelpWithPeopleAgentProvider,
                seekClarificationAgent: SeekClarificationAgentProvider,
                taskInsightsAgent: TaskInsightsProvider,
                projectInsightsAgent: ProjectInsightsAgentProvider,
                codeReviewAgent: CodeReviewAgentProvider,
                teamSelectionAgent: TeamSelectionAgentProvider,
                genericQueryAgent: GenericQueryAgentProvider,
                // ADD agent here
            ) => ({
                improveTaskQuality: improveTaskAgent,
                defaultPrompt: defaultAgent,
                helpWithCode: helpWithCodeAgent,
                helpWithTask: helpWithTaskAgent,
                helpWithPeople: helpWithPeopleAgent,
                seekClarification: seekClarificationAgent,
                taskInsights: taskInsightsAgent,
                projectInsights: projectInsightsAgent,
                codeReview: codeReviewAgent,
                teamSelectionAgent: teamSelectionAgent,
                genericQuery: genericQueryAgent,
            }),
            inject: [
                ImproveTaskAgentProvider,
                DefaultAgentProvider,
                HelpWithCodeAgentProvider,
                HelpWithTaskAgentProvider,
                HelpWithPeopleAgentProvider,
                SeekClarificationAgentProvider,
                TaskInsightsProvider,
                ProjectInsightsAgentProvider,
                CodeReviewAgentProvider,
                TeamSelectionAgentProvider,
                GenericQueryAgentProvider,
            ],
        },
        {
            provide: AGENT_SERVICE_TOKEN,
            useClass: AgentService,
        },
        {
            provide: AGENT_EXECUTION_SERVICE_TOKEN,
            useClass: AgentExecutionService,
        },
        {
            provide: AGENT_EXECUTION_REPOSITORY_TOKEN,
            useClass: AgentExecutionDatabaseRepository,
        },
        PromptRouter,
    ],
    controllers: [AgentController],
    exports: [
        PromptRouter,
        AGENT_SERVICE_TOKEN,
        AGENT_EXECUTION_SERVICE_TOKEN,
        AGENT_EXECUTION_REPOSITORY_TOKEN,
    ],
})
export class AgentModule { }
