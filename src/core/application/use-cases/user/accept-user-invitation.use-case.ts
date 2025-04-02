import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, NotFoundException } from '@nestjs/common';

import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { STATUS } from '@/config/types/database/status.type';
import { AcceptUserInvitationDto } from '@/core/infrastructure/http/dtos/accept-user-invitation.dto';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { CreateProfileUseCase } from '../profile/create.use-case';

// @Case()
export class AcceptUserInvitationUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,

        private readonly createProfileUseCase: CreateProfileUseCase,
    ) { }
    public async execute(user: AcceptUserInvitationDto): Promise<any> {
        const userUpdated = await this.usersService.update(
            {
                uuid: user.uuid,
            },
            {
                status: STATUS.ACTIVE,
                password: await this.authService.hashPassword(
                    user.password,
                    10,
                ),
            },
        );

        if (!userUpdated) {
            throw new NotFoundException("User could not be found")
        }

        await this.createProfileUseCase.execute({
            user: { uuid: user.uuid },
            name: user.name,
            phone: user?.phone
        });

        return userUpdated;
    }
}
