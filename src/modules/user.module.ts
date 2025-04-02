import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UseCases } from '@/core/application/use-cases/user';
import { PASSWORD_SERVICE_TOKEN } from '@/core/domain/user/contracts/password.service.contract';
import { USER_REPOSITORY_TOKEN } from '@/core/domain/user/contracts/user.repository.contract';
import { USER_SERVICE_TOKEN } from '@/core/domain/user/contracts/user.service.contract';
import { UserModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/user.model';
import { UserDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/user.repository';
import { BcryptService } from '@/core/infrastructure/adapters/services/bcrypt.service';
import { UsersService } from '@/core/infrastructure/adapters/services/users.service';
import { UsersController } from '@/core/infrastructure/http/controllers/user.controller';
import { AuthModule } from './auth.module';
import { CreateUserUseCase } from '@/core/application/use-cases/user/create.use-case';
import { ProfilesModule } from './profiles.module';
import { TeamsModule } from './team.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([UserModel]),
        forwardRef(() => AuthModule),
        forwardRef(() => ProfilesModule),
        forwardRef(() => TeamsModule),
    ],
    providers: [
        ...UseCases,
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
    exports: [USER_REPOSITORY_TOKEN, USER_SERVICE_TOKEN, CreateUserUseCase],
    controllers: [UsersController],
})
export class UsersModule {}
