import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { REQUEST } from '@nestjs/core';

@Injectable() // @Case()
export class GetUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },
    ) {}
    public async execute(): Promise<IUser> {
        const userId = this.request.user?.uuid;
        const organizationId = this.request.user?.organization.uuid;

        const userExists = await this.usersService.count({ uuid: userId });

        if (!userExists) {
            throw new NotFoundException('api.users.not_found');
        }

        const user = await this.usersService.findOne({ uuid: userId });

        return user.toObject();
    }
}
