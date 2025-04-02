import { ActiveTeamAutomationsUseCase } from './activeTeamAutomationsUseCase';
import { GetTeamAutomationUseCase } from './getTeamAutomationUseCase';
import { ListAllTeamAutomationUseCase } from './listAllTeamAutomationUseCase';
import { UpdateTeamAutomationStatusUseCase } from './updateTeamAutomationStatusUseCase';
import { RunTeamAutomationsUseCase } from './run-team-automations';
import { UpdateOrCreateTeamAutomationUseCase } from './updateOrCreateTeamAutomationUseCase';
import { ActiveCodeManagementTeamAutomationsUseCase } from './active-code-manegement-automations.use-case';
import { ActiveProjectManagementTeamAutomationsUseCase } from './active-project-management-automations.use-case';
import { ActiveCommunicationManagementTeamAutomationsUseCase } from './active-communication-management-automations.use-case';
import { GenerateCodeArtifactsUseCase } from '../platformIntegration/codeManagement/generate-code-artifacts.use-case';
import { ActiveCodeReviewAutomationUseCase } from './active-code-review-automation.use-case';

export const UseCases = [
    UpdateOrCreateTeamAutomationUseCase,
    GetTeamAutomationUseCase,
    ListAllTeamAutomationUseCase,
    UpdateTeamAutomationStatusUseCase,
    ActiveTeamAutomationsUseCase,
    RunTeamAutomationsUseCase,
    ActiveCodeManagementTeamAutomationsUseCase,
    ActiveProjectManagementTeamAutomationsUseCase,
    ActiveCommunicationManagementTeamAutomationsUseCase,
    GenerateCodeArtifactsUseCase,
    ActiveCodeReviewAutomationUseCase
];
