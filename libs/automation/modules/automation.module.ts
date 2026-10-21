import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SaveCodeReviewFeedbackUseCase } from '@libs/code-review/application/use-cases/codeReviewFeedback/save-feedback.use-case';
import { UseCases as SaveCodeReviewFeedbackUseCases } from '@libs/code-review/application/use-cases/codeReviewFeedback';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { CodeReviewFeedbackModule } from '@libs/code-review/modules/codeReviewFeedback.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from '@libs/integrations/modules/config-core.module';
import { IntegrationCoreModule } from '@libs/integrations/modules/integrations-core.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { ProfileConfigModule } from '@libs/identity/modules/profileConfig.module';
import { GithubModule } from '@libs/platform/modules/github.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { AutomationModel } from '../infrastructure/adapters/repositories/schemas/automation.model';
import { AutomationExecutionModel } from '../infrastructure/adapters/repositories/schemas/automationExecution.model';
import { UseCases as TeamAutomationUseCases } from '../application/use-cases/teamAutomation';
import { ActiveCodeManagementTeamAutomationsUseCase } from '../application/use-cases/teamAutomation/active-code-manegement-automations.use-case';
import { ActiveCodeReviewAutomationUseCase } from '../application/use-cases/teamAutomation/active-code-review-automation.use-case';
import { TEAM_AUTOMATION_REPOSITORY_TOKEN } from '../domain/teamAutomation/contracts/team-automation.repository';
import { TEAM_AUTOMATION_SERVICE_TOKEN } from '../domain/teamAutomation/contracts/team-automation.service';
import { TeamAutomationModel } from '../infrastructure/adapters/repositories/schemas/teamAutomation.model';
import { TeamAutomationRepository } from '../infrastructure/adapters/repositories/teamAutomation.repository';
import { TeamAutomationService } from '../infrastructure/adapters/services/teamAutomation.service';
import { EXECUTE_AUTOMATION_SERVICE_TOKEN } from '../domain/automationExecution/contracts/execute.automation.service.contracts';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { AUTOMATION_REPOSITORY_TOKEN } from '../domain/automation/contracts/automation.repository';
import { AutomationRepository } from '../infrastructure/adapters/repositories/automation.repository';
import { AUTOMATION_SERVICE_TOKEN } from '../domain/automation/contracts/automation.service';
import { AutomationService } from '../infrastructure/adapters/services/automation.service';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '../domain/automationExecution/contracts/automation-execution.service';
import { AutomationExecutionService } from '../infrastructure/adapters/services/automationExecution.service';
import { AUTOMATION_EXECUTION_REPOSITORY_TOKEN } from '../domain/automationExecution/contracts/automation-execution.repository';
import { AutomationExecutionRepository } from '../infrastructure/adapters/repositories/automationExecution.repository';
import { AutomationCodeReviewService } from '../infrastructure/adapters/services/processAutomation/strategies/automationCodeReview';
import { ExecuteAutomationService } from '../infrastructure/adapters/services/processAutomation/config/execute.automation';
import { AutomationRegistry } from '../infrastructure/adapters/services/processAutomation/config/register.automation';
import { TeamMembersCoreModule } from '@libs/organization/modules/teamMembers-core.module';

import { OrganizationParametersModule } from '@libs/organization/modules/organizationParameters.module';
import { CodeReviewCoreModule } from '@libs/code-review/modules/code-review-core.module';
import { EnqueueImplementationCheckUseCase } from '@libs/code-review/application/use-cases/enqueue-implementation-check.use-case';
import { JOB_QUEUE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WorkflowJobQueueService } from '@libs/core/workflow/infrastructure/workflow-job-queue.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            AutomationModel,
            AutomationExecutionModel,
            TeamAutomationModel,
        ]),
        forwardRef(() => TeamModule),
        forwardRef(() => TeamMembersCoreModule),
        forwardRef(() => GithubModule),
        forwardRef(() => PlatformModule),
        forwardRef(() => IntegrationCoreModule),
        forwardRef(() => IntegrationConfigCoreModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => CodeReviewFeedbackModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => CodeReviewCoreModule),
        forwardRef(() => ProfileConfigModule),
        forwardRef(() => LicenseModule),
        forwardRef(() => PermissionValidationModule),
        forwardRef(() => OrganizationParametersModule),
    ],
    providers: [
        SaveCodeReviewFeedbackUseCase,
        RunCodeReviewAutomationUseCase,
        {
            provide: AUTOMATION_REPOSITORY_TOKEN,
            useClass: AutomationRepository,
        },
        {
            provide: AUTOMATION_SERVICE_TOKEN,
            useClass: AutomationService,
        },
        {
            provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
            useClass: AutomationExecutionService,
        },
        {
            provide: AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
            useClass: AutomationExecutionRepository,
        },

        // --- Team Automation Providers ---
        ...TeamAutomationUseCases,
        {
            provide: TEAM_AUTOMATION_REPOSITORY_TOKEN,
            useClass: TeamAutomationRepository,
        },
        {
            provide: TEAM_AUTOMATION_SERVICE_TOKEN,
            useClass: TeamAutomationService,
        },

        // --- Automation Strategy Providers ---
        ...SaveCodeReviewFeedbackUseCases,
        AutomationCodeReviewService,
        {
            provide: EXECUTE_AUTOMATION_SERVICE_TOKEN,
            useClass: ExecuteAutomationService,
        },
        {
            provide: 'STRATEGIES_AUTOMATION',
            useFactory: (
                automationCodeReviewService: AutomationCodeReviewService,
            ) => {
                return [automationCodeReviewService];
            },
            inject: [AutomationCodeReviewService],
        },
        AutomationRegistry,

        // Job queue provided locally: importing WorkflowModule.register()
        // here would close a cycle (WorkflowModule imports this module) and
        // duplicate its providers. Repositories come from the global
        // WorkflowCoreModule.
        {
            provide: JOB_QUEUE_SERVICE_TOKEN,
            useClass: WorkflowJobQueueService,
        },
        EnqueueImplementationCheckUseCase,
    ],
    exports: [
        // --- Automation Exports ---
        AUTOMATION_REPOSITORY_TOKEN,
        AUTOMATION_SERVICE_TOKEN,
        AUTOMATION_EXECUTION_SERVICE_TOKEN,
        AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
        RunCodeReviewAutomationUseCase,

        // --- Team Automation Exports ---
        TEAM_AUTOMATION_REPOSITORY_TOKEN,
        TEAM_AUTOMATION_SERVICE_TOKEN,
        ActiveCodeManagementTeamAutomationsUseCase,
        ActiveCodeReviewAutomationUseCase,

        // --- Automation Strategy Exports ---
        'STRATEGIES_AUTOMATION',
        EXECUTE_AUTOMATION_SERVICE_TOKEN,
        AutomationRegistry,
    ],
})
export class AutomationModule {}
