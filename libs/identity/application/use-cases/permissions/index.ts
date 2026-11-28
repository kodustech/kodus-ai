import { AssignReposUseCase } from './assign-repos.use-case';
import { CanAccessUseCase } from './can-access.use-case';
import { ConnectionAccessUseCase } from './connection-access.use-case';
import { GetAssignedReposUseCase } from './get-assigned-repos.use-case';
import { GetPermissionsUseCase } from './get-permissions.use-case';

export const UseCases = [
    GetPermissionsUseCase,
    CanAccessUseCase,
    GetAssignedReposUseCase,
    AssignReposUseCase,
    ConnectionAccessUseCase,
];
