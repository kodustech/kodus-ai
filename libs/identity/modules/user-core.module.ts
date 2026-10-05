import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModel } from '../infrastructure/adapters/repositories/schemas/auth.model'; // Added
import { UserModel } from '../infrastructure/adapters/repositories/schemas/user.model';

import { CryptoModule } from '@libs/core/crypto/crypto.module';
import { ProfilesModule } from './profiles.module';
import { PASSWORD_SERVICE_TOKEN } from '../domain/user/contracts/password.service.contract';
import { USER_REPOSITORY_TOKEN } from '../domain/user/contracts/user.repository.contract';
import { USER_SERVICE_TOKEN } from '../domain/user/contracts/user.service.contract';
import { UserDatabaseRepository } from '../infrastructure/adapters/repositories/user.repository';
import { BcryptService } from '../infrastructure/adapters/services/bcrypt.service';
import { UsersService } from '../infrastructure/adapters/services/users.service';

import { GetUserUseCase } from '../application/use-cases/user';
import { CheckUserWithEmailUserUseCase } from '../application/use-cases/user/check-user-email.use-case';
import { DeleteUserUseCase } from '../application/use-cases/user/delete.use-case';
import { InviteDataUserUseCase } from '../application/use-cases/user/invite-data.use-case';

@Module({
    imports: [
        TypeOrmModule.forFeature([UserModel, AuthModel]), // Added AuthModel
        CryptoModule,
        ProfilesModule,
    ],
    providers: [
        DeleteUserUseCase,
        CheckUserWithEmailUserUseCase,
        InviteDataUserUseCase,
        GetUserUseCase,
        {
            provide: USER_REPOSITORY_TOKEN,
            useClass: UserDatabaseRepository,
        },
        {
            provide: USER_SERVICE_TOKEN,
            useClass: UsersService,
        },
        {
            provide: PASSWORD_SERVICE_TOKEN,
            useClass: BcryptService,
        },
    ],
    exports: [
        USER_REPOSITORY_TOKEN,
        USER_SERVICE_TOKEN,
        PASSWORD_SERVICE_TOKEN,
        DeleteUserUseCase,
        CheckUserWithEmailUserUseCase,
        InviteDataUserUseCase,
        GetUserUseCase,
    ],
})
export class UserCoreModule {}
