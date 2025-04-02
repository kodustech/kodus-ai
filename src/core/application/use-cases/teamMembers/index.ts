import { PredictTeamCreationUseCase } from './automatic-team-creation.use-case';
import { CreateOrUpdateTeamMembersUseCase } from './create.use-case';
import { DeleteTeamMembersUseCase } from './delete.use-case';
import { GetTeamMemberByRelationsUseCase } from './get-by-relations.use-case';
import { GetTeamMembersUseCase } from './get-team-members.use-case';
import { SendInvitesUseCase } from './send-invites.use-case';

export const UseCases = [
    CreateOrUpdateTeamMembersUseCase,
    GetTeamMembersUseCase,
    GetTeamMemberByRelationsUseCase,
    PredictTeamCreationUseCase,
    SendInvitesUseCase,
    DeleteTeamMembersUseCase,
];
