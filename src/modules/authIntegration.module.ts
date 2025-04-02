import { AUTH_INTEGRATION_REPOSITORY_TOKEN } from '@/core/domain/authIntegrations/contracts/auth-integration.repository.contracts';
import { AUTH_INTEGRATION_SERVICE_TOKEN } from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import { AuthIntegrationRepository } from '@/core/infrastructure/adapters/repositories/typeorm/authIntegration.repository';
import { AuthIntegrationModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/authIntegration.model';
import { AuthIntegrationService } from '@/core/infrastructure/adapters/services/integrations/authIntegration.service';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
    imports: [TypeOrmModule.forFeature([AuthIntegrationModel])],
    providers: [
        {
            provide: AUTH_INTEGRATION_SERVICE_TOKEN,
            useClass: AuthIntegrationService,
        },
        {
            provide: AUTH_INTEGRATION_REPOSITORY_TOKEN,
            useClass: AuthIntegrationRepository,
        },
    ],
    exports: [
        AUTH_INTEGRATION_SERVICE_TOKEN,
        AUTH_INTEGRATION_REPOSITORY_TOKEN,
    ],
})
export class AuthIntegrationModule {}
