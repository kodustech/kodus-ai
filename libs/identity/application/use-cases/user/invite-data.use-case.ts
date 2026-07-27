import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class InviteDataUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
    ) {}

    public async execute(uuid: string): Promise<Partial<IUser>> {
        if (!uuid) {
            return {};
        }

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
