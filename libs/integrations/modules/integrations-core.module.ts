import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { IntegrationRepository } from '../infrastructure/adapters/repositories/integration.repository';
import { IntegrationModel } from '../infrastructure/adapters/repositories/schemas/integration.model';
import { ProfileConfigModule } from '@libs/identity/modules/profileConfig.module';
import { AuthIntegrationModule } from '@libs/integrations/modules/authIntegration.module';
import { IntegrationConfigCoreModule } from './config-core.module';
import { TeamModule } from '@libs/organization/modules/team.module';

import { INTEGRATION_REPOSITORY_TOKEN } from '../domain/integrations/contracts/integration.repository.contracts';
import { INTEGRATION_SERVICE_TOKEN } from '../domain/integrations/contracts/integration.service.contracts';
import { IntegrationService } from '../infrastructure/adapters/services/integration.service';

// Use Cases
import { CloneIntegrationUseCase } from '../application/use-cases/clone-integration.use-case';
import { GetOrganizationIdUseCase } from '../application/use-cases/get-organization-id.use-case';
import { GetIntegrationConfigsByIntegrationCategoryUseCase } from '../application/use-cases/integrationConfig/getIntegrationConfigsByIntegrationCategory.use-case';
import { CheckHasIntegrationByPlatformUseCase } from '../application/use-cases/check-has-connection.use-case';

const UseCases = [
    CloneIntegrationUseCase,
    GetOrganizationIdUseCase,
    GetIntegrationConfigsByIntegrationCategoryUseCase,
    CheckHasIntegrationByPlatformUseCase,
];

@Module({
    imports: [
        TypeOrmModule.forFeature([IntegrationModel]),
        IntegrationConfigCoreModule,
        forwardRef(() => ProfileConfigModule),
        AuthIntegrationModule,
        forwardRef(() => TeamModule),
    ],
    providers: [
        ...UseCases,
        {
            provide: INTEGRATION_SERVICE_TOKEN,
            useClass: IntegrationService,
        },
        {
            provide: INTEGRATION_REPOSITORY_TOKEN,
            useClass: IntegrationRepository,
        },
    ],
    exports: [
        INTEGRATION_SERVICE_TOKEN,
        INTEGRATION_REPOSITORY_TOKEN,
        ...UseCases,
    ],
})
export class IntegrationCoreModule {}
