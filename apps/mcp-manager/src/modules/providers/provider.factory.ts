import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationOAuthService } from '../integrations/integration-oauth.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { ComposioProvider } from './composio/composio.provider';
import { CustomProvider } from './custom/custom.provider';
import { MCPProvider } from './interfaces/provider.interface';
import { KodusMCPProvider } from './kodusMCP/kodus-mcp.provider';
import { IntegrationDescriptionService } from './services/integration-description.service';

export type ProviderType = string;

@Injectable()
export class ProviderFactory {
    private providers: Map<ProviderType, MCPProvider> = new Map();
    private logger: Logger = new Logger(ProviderFactory.name);

    constructor(
        private configService: ConfigService,
        private integrationDescriptionService: IntegrationDescriptionService,
        private integrationsService: IntegrationsService,
        private integrationOAuthService: IntegrationOAuthService,
    ) {
        this.initializeProviders();
    }

    private initializeProviders(): void {
        const enabledProviders = this.configService
            .get<string>('providers', 'composio,kodusmcp,custom')
            .split(',')
            .map((provider) => provider.trim())
            .filter(Boolean);

        for (const provider of enabledProviders) {
            switch (provider) {
                case 'composio':
                    this.providers.set(
                        'composio',
                        new ComposioProvider(
                            this.configService,
                            this.integrationDescriptionService,
                        ),
                    );
                    break;
                case 'kodusmcp':
                    this.providers.set(
                        'kodusmcp',
                        new KodusMCPProvider(
                            this.integrationDescriptionService,
                            this.integrationOAuthService,
                        ),
                    );
                    break;
                case 'custom':
                    this.providers.set(
                        'custom',
                        new CustomProvider(
                            this.configService,
                            this.integrationDescriptionService,
                            this.integrationsService,
                            this.integrationOAuthService,
                        ),
                    );
                    break;
                default:
                    throw new Error(`Provider ${provider} not supported`);
            }
        }
    }

    getProvider(type: ProviderType): MCPProvider {
        const provider = this.providers.get(type);
        if (!provider) {
            throw new Error(`Provider ${type} not found`);
        }
        return provider;
    }

    getProviders(): MCPProvider[] {
        return Array.from(this.providers.values());
    }
}
