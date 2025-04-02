import { CreateAuthIntegrationUseCase } from './create-auth-integration.use-case';
import { CreateIntegrationUseCase } from './create-integration.use-case';
import { CreateOrUpdateIntegrationConfigUseCase } from './create-or-update-auth-configs.use-case';
import { CreateOrUpdateColumnsBoardUseCase } from './create-or-update-board-columns.use-case';
import { FinishProjectConfigUseCase } from './finish-project-config.use-case';
import { GetAuthUrlUseCase } from './get-auth-url.use-case';
import { GetBoardsListUseCase } from './get-boards-list.use-case';
import { GetColumnsBoardUseCase } from './get-columns-board.use-case';
import { GetDomainsListUseCase } from './get-domain-list.use-case';
import { GetEpicsUseCase } from './get-epics.use-case';
import { GetProjectsListUseCase } from './get-project-list.use-case';
import { GetProjectManagementMemberListUseCase } from './get-project-management-members-list.use-case';
import { GetEffortTeamUseCase } from './get-team-effort.use-case';
import { GetTeamListUseCase } from './get-team-list.use-case';
import { GetWorkitemTypesUseCase } from './get-workitem-types.use-case';
import { SaveConfigUseCase } from './save-config.use-case';
import { UpdateAuthIntegrationUseCase } from './update-auth-integration.use-case';

export default [
    CreateAuthIntegrationUseCase,
    CreateOrUpdateIntegrationConfigUseCase,
    GetAuthUrlUseCase,
    GetProjectManagementMemberListUseCase,
    UpdateAuthIntegrationUseCase,
    GetBoardsListUseCase,
    GetColumnsBoardUseCase,
    GetDomainsListUseCase,
    GetProjectsListUseCase,
    CreateOrUpdateColumnsBoardUseCase,
    GetTeamListUseCase,
    SaveConfigUseCase,
    CreateIntegrationUseCase,
    GetEpicsUseCase,
    GetEffortTeamUseCase,
    GetWorkitemTypesUseCase,
    FinishProjectConfigUseCase,
];
