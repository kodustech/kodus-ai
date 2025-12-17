import { CreateOrUpdateOrganizationParametersUseCase } from '@/core/application/use-cases/organizationParameters/create-or-update.use-case';
import { DeleteByokConfigUseCase } from '@/core/application/use-cases/organizationParameters/delete-byok-config.use-case';
import { FindByKeyOrganizationParametersUseCase } from '@/core/application/use-cases/organizationParameters/find-by-key.use-case';
import {
    GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
    GetCockpitMetricsVisibilityUseCase,
} from '@/core/application/use-cases/organizationParameters/get-cockpit-metrics-visibility.use-case';
import { GetModelsByProviderUseCase } from '@/core/application/use-cases/organizationParameters/get-models-by-provider.use-case';
import { IgnoreBotsUseCase } from '@/core/application/use-cases/organizationParameters/ignore-bots.use-case';
import { UpdateAutoLicenseAllowedUsersUseCase } from '@/core/application/use-cases/organizationParameters/update-auto-license-allowed-users.use-case';
import { ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN } from '@/core/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersRepository } from '@/core/infrastructure/adapters/repositories/typeorm/organizationParameters.repository';
import { OrganizationParametersModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/organizationParameters.model';
import { OrganizationParametersService } from '@/core/infrastructure/adapters/services/organizationParameters.service';
import { PlatformIntegrationFactory } from '@/core/infrastructure/adapters/services/platformIntegration/platformIntegration.factory';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { ProviderService } from '@/core/infrastructure/adapters/services/providers/provider.service';
import { OrgnizationParametersController } from '@/core/infrastructure/http/controllers/organizationParameters.controller';
import { LicenseModule } from '@/ee/license/license.module';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CodebaseModule } from './codeBase.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { ParametersModule } from './parameters.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { TeamsModule } from './team.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([OrganizationParametersModel]),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => TeamsModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => LicenseModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => PlatformIntegrationModule),
    ],
    providers: [
        CreateOrUpdateOrganizationParametersUseCase,
        FindByKeyOrganizationParametersUseCase,
        GetModelsByProviderUseCase,
        DeleteByokConfigUseCase,
        IgnoreBotsUseCase,
        UpdateAutoLicenseAllowedUsersUseCase,
        {
            provide: GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
            useClass: GetCockpitMetricsVisibilityUseCase,
        },
        OrganizationParametersService,
        PromptService,
        PlatformIntegrationFactory,
        ProviderService,
        {
            provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
            useClass: OrganizationParametersService,
        },
        {
            provide: ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
            useClass: OrganizationParametersRepository,
        },
    ],
    controllers: [OrgnizationParametersController],
    exports: [
        ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
        ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
        OrganizationParametersService,
        GetModelsByProviderUseCase,
        DeleteByokConfigUseCase,
        IgnoreBotsUseCase,
        GET_COCKPIT_METRICS_VISIBILITY_USE_CASE_TOKEN,
    ],
})
export class OrganizationParametersModule {}
