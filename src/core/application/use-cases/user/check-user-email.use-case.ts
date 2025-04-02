import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { CreateProfileUseCase } from '../profile/create.use-case';
import { CreateTeamUseCase } from '../team/create.use-case';
import { STATUS } from '@/config/types/database/status.type';
import { UserRole } from '@/core/domain/user/enums/userRole.enum';
import { DuplicateRecordException } from '@/shared/infrastructure/filters/duplicate-record.exception';

@Injectable()
export class CheckUserWithEmailUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
    ) {}
    public async execute(email: any): Promise<Boolean> {
        const previousUser = await this.usersService.count({
            email,
        });

        if (previousUser) {
            throw new DuplicateRecordException(
                'An user with this e-mail already exists.',
                'DUPLICATE_USER_EMAIL',
            );
        }

        return !!previousUser;
    }
}
