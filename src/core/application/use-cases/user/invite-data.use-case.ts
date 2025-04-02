import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, NotFoundException } from '@nestjs/common';

import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { STATUS } from '@/config/types/database/status.type';

// @Case()
export class InviteDataUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
    ) {}
    public async execute(uuid: string): Promise<IUser | {}> {
        const user = await this.usersService.findOne({
            uuid,
            status: STATUS.PENDING,
        });

        if (!user) {
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
