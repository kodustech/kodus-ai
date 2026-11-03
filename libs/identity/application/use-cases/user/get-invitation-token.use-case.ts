import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { sealInvitation } from '@libs/identity/domain/user/invitation-token';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

/**
 * A fresh invitation token for the admin's "copy invite link": only for an
 * open invitation (PENDING, no profile yet) of the admin's own organization.
 */
@Injectable()
export class GetInvitationTokenUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) {}

    public async execute(
        targetUserId: string,
        organizationId: string,
    ): Promise<{ token: string }> {
        const user =
            targetUserId && organizationId
                ? await this.usersService.findOne({
                      uuid: targetUserId,
                      status: STATUS.PENDING,
                      organization: { uuid: organizationId },
                  })
                : null;
        if (
            !user?.email ||
            (await this.profileService.findOne({
                user: { uuid: targetUserId },
            }))
        ) {
            throw new NotFoundException('No open invitation for this user');
        }

        return {
            token: sealInvitation({ userId: user.uuid, email: user.email }),
        };
    }
}
