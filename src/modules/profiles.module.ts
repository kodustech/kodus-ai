import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UseCases } from '@/core/application/use-cases/profile';
import { ProfileModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/profile.model';
import { ProfileDatabaseRepository } from '@/core/infrastructure/adapters/repositories/typeorm/profile.repository';
import { ProfilesService } from '@/core/infrastructure/adapters/services/profile.service';
import { PROFILE_SERVICE_TOKEN } from '@/core/domain/profile/contracts/profile.service.contract';
import { PROFILE_REPOSITORY_TOKEN } from '@/core/domain/profile/contracts/profile.repository.contract';
import { CreateProfileUseCase } from '@/core/application/use-cases/profile/create.use-case';
import { UpdateProfileUseCase } from '@/core/application/use-cases/profile/update.use-case';

@Module({
    imports: [TypeOrmModule.forFeature([ProfileModel])],
    providers: [
        ...UseCases,
        {
            provide: PROFILE_REPOSITORY_TOKEN,
            useClass: ProfileDatabaseRepository,
        },
        {
            provide: PROFILE_SERVICE_TOKEN,
            useClass: ProfilesService,
        },
    ],
    exports: [
        PROFILE_SERVICE_TOKEN,
        PROFILE_REPOSITORY_TOKEN,
        CreateProfileUseCase,
        UpdateProfileUseCase,
    ],
    controllers: [],
})
export class ProfilesModule {}
