import { AcceptUserInvitationUseCase } from './accept-user-invitation.use-case';
import { CheckUserWithEmailUserUseCase } from './check-user-email.use-case';
import { CreateUserUseCase } from './create.use-case';
import { DeleteUserUseCase } from './delete.use-case';
import { GetUserUseCase } from './get-user.use-case';
import { InviteDataUserUseCase } from './invite-data.use-case';
import { ListUsersUseCase } from './list.use-case';
import { UpdateUserProfileUseCase } from './update-profile.use-case';
import { UpdateUserUseCase } from './update.use-case';

export const UseCases = [
    ListUsersUseCase,
    UpdateUserProfileUseCase,
    CreateUserUseCase,
    UpdateUserUseCase,
    DeleteUserUseCase,
    GetUserUseCase,
    InviteDataUserUseCase,
    AcceptUserInvitationUseCase,
    CheckUserWithEmailUserUseCase,
];
