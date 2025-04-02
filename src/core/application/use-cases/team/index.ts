import { CreateTeamUseCase } from './create.use-case';
import { UpdateTeamUseCase } from './update.use-case';
import { ListTeamsUseCase } from './list.use-case';
import { FindFirstCreatedTeamUseCase } from './find-first-created-team.use-case';
import { GetByIdUseCase } from './get-by-id.use-case';
import { GetTeamInfosByTenantNameAndTeamNameUseCase } from './get-team-infos-by-tenant-name-and-team-name.use-case';
import { FinishSetupUseCase } from './finish-setup.use-case';
import { DeleteTeamUseCase } from './delete.use-case';
import { ListTeamsWithIntegrationsUseCase } from './list-with-integrations.use-case';
export const UseCases = [
    CreateTeamUseCase,
    UpdateTeamUseCase,
    ListTeamsUseCase,
    FindFirstCreatedTeamUseCase,
    GetByIdUseCase,
    GetTeamInfosByTenantNameAndTeamNameUseCase,
    FinishSetupUseCase,
    DeleteTeamUseCase,
    ListTeamsWithIntegrationsUseCase,
];
