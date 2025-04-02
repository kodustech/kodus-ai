import { INTEGRATION_REPOSITORY_TOKEN } from '@/core/domain/integrations/contracts/integration.repository.contracts';
import { IntegrationRepository } from '@/core/infrastructure/adapters/repositories/typeorm/integration.repository';
import { IntegrationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/integration.model';
import { IntegrationService } from '@/core/infrastructure/adapters/services/integrations/integration.service';
import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { INTEGRATION_SERVICE_TOKEN } from '@/core/domain/integrations/contracts/integration.service.contracts';
import { UseCases } from '@/core/application/use-cases/integrations';
import { IntegrationConfigModule } from './integrationConfig.module';
import { PlatformIntegrationModule } from './platformIntegration.module';
import { ProfileConfigModule } from './profileConfig.module';
import { IntegrationController } from '@/core/infrastructure/http/controllers/integrations/integration.controller';
import { AuthIntegrationModule } from './authIntegration.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([IntegrationModel]),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => PlatformIntegrationModule),
        ProfileConfigModule,
        AuthIntegrationModule,
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
    exports: [INTEGRATION_SERVICE_TOKEN, INTEGRATION_REPOSITORY_TOKEN],
    controllers: [IntegrationController],
})
export class IntegrationModule {}
