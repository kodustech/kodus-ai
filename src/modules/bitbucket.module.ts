import { BITBUCKET_SERVICE_TOKEN } from '@/core/domain/bitbucket/contracts/bitbucket.service.contract';
import { BitbucketService } from '@/core/infrastructure/adapters/services/bitbucket/bitbucket.service';
import { BitbucketController } from '@/core/infrastructure/http/controllers/bitbucket.controller';
import { forwardRef, Module } from '@nestjs/common';
import { AuthIntegrationModule } from './authIntegration.module';
import { IntegrationModule } from './integration.module';
import { IntegrationConfigModule } from './integrationConfig.module';
import { ParametersModule } from './parameters.module';
import { CodebaseModule } from './codeBase.module';
import { PlatformIntegrationModule } from './platformIntegration.module';

@Module({
    imports: [
        forwardRef(() => AuthIntegrationModule),
        forwardRef(() => IntegrationModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => ParametersModule),
        forwardRef(() => CodebaseModule),
        forwardRef(() => PlatformIntegrationModule),
    ],
    providers: [
        {
            provide: BITBUCKET_SERVICE_TOKEN,
            useClass: BitbucketService,
        },
    ],
    controllers: [BitbucketController],
    exports: [],
})
export class BitbucketModule {}
