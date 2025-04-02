import { GetProjectsListUseCase } from '@/core/application/use-cases/jira/get-project-list.use-case';
import { GetUsersInBoardByNameUseCase } from './get-users-in-board-by-name';
import { CreateOrUpdateColumnsBoardUseCase } from './create-or-update-jira-columns.use-case';
import { GetBoardsListUseCase } from '@/core/application/use-cases/jira/get-boards-list.use-case';
import { GetDomainsListUseCase } from '@/core/application/use-cases/jira/get-domain-list.use-case';
import { FinishProjectConfigUseCase } from '../platformIntegration/projectManagement/finish-project-config.use-case';

export const UseCases = [
    GetUsersInBoardByNameUseCase,
    GetDomainsListUseCase,
    GetProjectsListUseCase,
    GetBoardsListUseCase,
    CreateOrUpdateColumnsBoardUseCase,
    FinishProjectConfigUseCase,
];
