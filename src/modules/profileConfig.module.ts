import { PROFILE_CONFIG_REPOSITORY_TOKEN } from '@/core/domain/profileConfigs/contracts/profileConfig.repository.contract';
import { PROFILE_CONFIG_SERVICE_TOKEN } from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { ProfileConfigRepository } from '@/core/infrastructure/adapters/repositories/typeorm/profileConfig.repository';
import { ProfileConfigModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/profileConfig.model';
import { ProfileConfigService } from '@/core/infrastructure/adapters/services/profileConfig.service';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from './user.module';
import { ProfilesModule } from './profiles.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([ProfileConfigModel]),
        forwardRef(() => UsersModule),
        forwardRef(() => ProfilesModule)
    ],
    providers: [
        {
            provide: PROFILE_CONFIG_SERVICE_TOKEN,
            useClass: ProfileConfigService,
        },
        {
            provide: PROFILE_CONFIG_REPOSITORY_TOKEN,
            useClass: ProfileConfigRepository,
        },
    ],
    exports: [PROFILE_CONFIG_SERVICE_TOKEN, PROFILE_CONFIG_REPOSITORY_TOKEN],
})
export class ProfileConfigModule { }
