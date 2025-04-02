import { UseCasesIntegrationConfig } from '@/core/application/use-cases/integrations';
import { INTEGRATION_CONFIG_REPOSITORY_TOKEN } from '@/core/domain/integrationConfigs/contracts/integration-config.repository.contracts';
import { INTEGRATION_CONFIG_SERVICE_TOKEN } from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigRepository } from '@/core/infrastructure/adapters/repositories/typeorm/integrationConfig.repository';
import { IntegrationConfigModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/integrationConfig.model';
import { IntegrationConfigService } from '@/core/infrastructure/adapters/services/integrations/integrationConfig.service';
import { IntegrationConfigController } from '@/core/infrastructure/http/controllers/integrations/integrationConfig.controller';
import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationModule } from './integration.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([IntegrationConfigModel]),
        forwardRef(() => IntegrationModule),
    ],
    providers: [
        ...UseCasesIntegrationConfig,
        {
            provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
            useClass: IntegrationConfigService,
        },
        {
            provide: INTEGRATION_CONFIG_REPOSITORY_TOKEN,
            useClass: IntegrationConfigRepository,
        },
    ],
    exports: [
        INTEGRATION_CONFIG_SERVICE_TOKEN,
        INTEGRATION_CONFIG_REPOSITORY_TOKEN,
    ],
    controllers: [IntegrationConfigController],
})
export class IntegrationConfigModule {}
