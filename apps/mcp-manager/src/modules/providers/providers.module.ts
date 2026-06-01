import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProviderFactory } from './provider.factory';
import { IntegrationDescriptionService } from './services/integration-description.service';

@Module({
    imports: [IntegrationsModule],
    providers: [ProviderFactory, IntegrationDescriptionService],
    exports: [ProviderFactory, IntegrationDescriptionService],
})
export class ProvidersModule {}
