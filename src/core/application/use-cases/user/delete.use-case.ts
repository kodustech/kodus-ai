import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { USER_SERVICE_TOKEN } from '@/core/domain/user/contracts/user.service.contract';
import { UsersService } from '@/core/infrastructure/adapters/services/users.service';

@Injectable()
export class DeleteUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: UsersService,
    ) {}

    public async execute(uuid: string): Promise<void> {
        const userExists = await this.usersService.count({ uuid });

        if (!userExists) {
            throw new NotFoundException('api.users.not_found');
        }

        await this.usersService.delete(uuid);
    }
}
