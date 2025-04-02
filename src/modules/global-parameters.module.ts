import { GLOBAL_PARAMETERS_REPOSITORY_TOKEN } from '@/core/domain/global-parameters/contracts/global-parameters.repository.contracts';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@/core/domain/global-parameters/contracts/global-parameters.service.contract';
import { GlobalParametersRepository } from '@/core/infrastructure/adapters/repositories/typeorm/global-parameters.repository';
import { GlobalParametersModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/global-parameters.model';
import { GlobalParametersService } from '@/core/infrastructure/adapters/services/global-parameters.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
    imports: [TypeOrmModule.forFeature([GlobalParametersModel])],
    providers: [
        {
            provide: GLOBAL_PARAMETERS_SERVICE_TOKEN,
            useClass: GlobalParametersService,
        },
        {
            provide: GLOBAL_PARAMETERS_REPOSITORY_TOKEN,
            useClass: GlobalParametersRepository,
        },
    ],
    exports: [
        GLOBAL_PARAMETERS_SERVICE_TOKEN,
        GLOBAL_PARAMETERS_REPOSITORY_TOKEN,
    ],
})
export class GlobalParametersModule {}
