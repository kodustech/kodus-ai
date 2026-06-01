import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OrganizationParametersService } from '../infrastructure/adapters/services/organizationParameters.service';
import { OrganizationParametersModel } from '../infrastructure/adapters/repositories/schemas/organizationParameters.model';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '../domain/organizationParameters/contracts/organizationParameters.service.contract';
import { ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN } from '../domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { OrganizationParametersRepository } from '../infrastructure/adapters/repositories/organizationParameters.repository';
import { CreateOrUpdateOrganizationParametersUseCase } from '../application/use-cases/organizationParameters/create-or-update.use-case';
import { FindByKeyOrganizationParametersUseCase } from '../application/use-cases/organizationParameters/find-by-key.use-case';
import { DeleteByokConfigUseCase } from '../application/use-cases/organizationParameters/delete-byok-config.use-case';
import { GetLLMConfigStatusUseCase } from '../application/use-cases/organizationParameters/get-llm-config-status.use-case';
import { IgnoreBotsUseCase } from '../application/use-cases/organizationParameters/ignore-bots.use-case';
import {
    GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
    GetCockpitMetricsVisibilityUseCase,
    GetModelsByProviderUseCase,
    TestByokConnectionUseCase,
} from '../application/use-cases/organizationParameters';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { ProviderModule } from '@libs/core/infrastructure/services/providers/provider.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationParametersModel]),
        forwardRef(() => PlatformModule),
        forwardRef(() => CodebaseModule),
        ProviderModule,
    ],
    providers: [
        {
            provide: GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
            useClass: GetCockpitMetricsVisibilityUseCase,
        },
        {
            provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
            useClass: OrganizationParametersService,
        },
        {
            provide: ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
            useClass: OrganizationParametersRepository,
        },
        CreateOrUpdateOrganizationParametersUseCase,
        FindByKeyOrganizationParametersUseCase,
        DeleteByokConfigUseCase,
        GetLLMConfigStatusUseCase,
        IgnoreBotsUseCase,
        GetModelsByProviderUseCase,
        TestByokConnectionUseCase,
    ],
    exports: [
        ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
        ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
        CreateOrUpdateOrganizationParametersUseCase,
        FindByKeyOrganizationParametersUseCase,
        DeleteByokConfigUseCase,
        GetLLMConfigStatusUseCase,
        IgnoreBotsUseCase,
        GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
        GetModelsByProviderUseCase,
        TestByokConnectionUseCase,
        ProviderModule, // Added
    ],
})
export class OrganizationParametersModule {}
