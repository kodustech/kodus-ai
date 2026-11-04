import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';

import {
    isInvitedEmail,
    openInvitation,
} from '@libs/identity/domain/user/invitation-token';

@Injectable()
export class InviteDataUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) {}

    public async execute(token: string): Promise<Partial<IUser>> {
        // The link carries a sealed invitation, not the user id: the id is
        // exposed elsewhere and would let anyone open the invitation.
        const invitation = openInvitation(token);
        if (!invitation) {
            return {};
        }

        const user = await this.usersService.findOne({
            uuid: invitation.userId,
            status: STATUS.PENDING,
        });

        // Public route: only an open invitation (no profile yet) is shown,
        // the same rule AcceptUserInvitationUseCase applies. A self sign-up
        // still confirming its email is PENDING too, but already has one.
        if (
            !user ||
            !isInvitedEmail(invitation, user.email) ||
            (await this.profileService.findOne({
                user: { uuid: invitation.userId },
            }))
        ) {
            return {};
        }

        const userObject = user.toObject();

        return {
            uuid: userObject.uuid,
            email: userObject.email,
            organization: { name: userObject?.organization?.name },
        };
    }
}
