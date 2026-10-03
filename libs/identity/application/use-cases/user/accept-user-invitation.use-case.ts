import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { CreateProfileUseCase } from '../profile/create.use-case';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { CryptoService } from '@libs/core/crypto/crypto.service';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { AcceptUserInvitationDto } from '@libs/identity/dtos/accept-user-invitation.dto';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';

@Injectable()
export class AcceptUserInvitationUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        private readonly cryptoService: CryptoService,

        private readonly createProfileUseCase: CreateProfileUseCase,
        private readonly telemetry: TelemetryService,

        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) {}
    public async execute(user: AcceptUserInvitationDto): Promise<any> {
        // This route is public and the uuid is the only input that names the
        // account, so it may only finish an invitation that is still open: a
        // PENDING user created by an invite, who has no profile yet (the
        // profile is created below, and self sign-ups create one at sign-up).
        // Anything else would let anyone set the password of any account.
        const invited = user?.uuid
            ? await this.usersService.findOne({
                  uuid: user.uuid,
                  status: STATUS.PENDING,
              })
            : null;
        const alreadyAccepted =
            invited &&
            (await this.profileService.findOne({
                user: { uuid: user.uuid },
            }));
        if (!invited || alreadyAccepted) {
            throw new NotFoundException('User could not be found');
        }

        const userUpdated = await this.usersService.update(
            {
                uuid: user.uuid,
                status: STATUS.PENDING,
            },
            {
                status: STATUS.ACTIVE,
                password: await this.cryptoService.hashPassword(
                    user.password,
                    10,
                ),
            },
        );

        if (!userUpdated) {
            throw new NotFoundException('User could not be found');
        }

        await this.createProfileUseCase.execute({
            user: { uuid: user.uuid },
            name: user.name,
            phone: user?.phone,
        });

        if (userUpdated.email) {
            void this.telemetry.userInvitationAccepted({
                userId: user.uuid,
                email: userUpdated.email,
                name: user.name,
                organizationId: userUpdated.organization?.uuid,
            });
        }

        return userUpdated;
    }
}
