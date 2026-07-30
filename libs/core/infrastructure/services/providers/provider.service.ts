import { Injectable } from '@nestjs/common';
import { BYOKProvider } from '@kodus/kodus-common/llm';

export interface ProviderInfo {
    id: string;
    name: string;
    description?: string;
    supported: boolean;
    requiresApiKey: boolean;
    requiresBaseUrl: boolean;
}

@Injectable()
export class ProviderService {
    private readonly providers: Record<string, ProviderInfo> = {
        [BYOKProvider.OPENAI]: {
            id: BYOKProvider.OPENAI,
            name: 'OpenAI',
            description: 'GPT models from OpenAI',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
        },
        [BYOKProvider.ANTHROPIC]: {
            id: BYOKProvider.ANTHROPIC,
            name: 'Anthropic',
            description: 'Claude models from Anthropic',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
        },
        [BYOKProvider.GOOGLE_GEMINI]: {
            id: BYOKProvider.GOOGLE_GEMINI,
            name: 'Google Gemini',
            description: 'Gemini models from Google AI',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
        },
        [BYOKProvider.GOOGLE_VERTEX]: {
            id: BYOKProvider.GOOGLE_VERTEX,
            name: 'Google Vertex AI',
            description:
                'Vertex AI models via service account (needs SA JSON + region)',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
        },
        [BYOKProvider.AMAZON_BEDROCK]: {
            id: BYOKProvider.AMAZON_BEDROCK,
            name: 'Amazon Bedrock',
            description:
                'AWS-hosted foundation models (needs AWS access key, secret, and region)',
            supported: true,
            requiresApiKey: false,
            requiresBaseUrl: false,
        },
        [BYOKProvider.OPEN_ROUTER]: {
            id: BYOKProvider.OPEN_ROUTER,
            name: 'OpenRouter',
            description: 'Multiple models through OpenRouter',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
        },
        [BYOKProvider.NOVITA]: {
            id: BYOKProvider.NOVITA,
            name: 'Novita',
            description: 'Open source models from Novita',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: false,
        },
        [BYOKProvider.OPENAI_COMPATIBLE]: {
            id: BYOKProvider.OPENAI_COMPATIBLE,
            name: 'OpenAI Compatible',
            description: 'Any OpenAI-compatible API endpoint',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: true,
        },
        [BYOKProvider.ANTHROPIC_COMPATIBLE]: {
            id: BYOKProvider.ANTHROPIC_COMPATIBLE,
            name: 'Anthropic Compatible',
            description:
                'Any Anthropic-compatible API endpoint (Kimi Code, Z.ai, DeepSeek, etc.)',
            supported: true,
            requiresApiKey: true,
            requiresBaseUrl: true,
        },
    };

    /**
     * Get all available providers
     */
    getAllProviders(): ProviderInfo[] {
        return Object.values(this.providers).filter(
            (provider) => provider.supported,
        );
    }

    /**
     * Get provider by ID
     */
    getProvider(providerId: string): ProviderInfo | null {
        return this.providers[providerId] || null;
    }

    /**
     * Check if provider is supported
     */
    isProviderSupported(providerId: string): boolean {
        const provider = this.providers[providerId];
        return provider ? provider.supported : false;
    }

    /**
     * Get provider display name
     */
    getProviderDisplayName(providerId: string): string {
        const provider = this.providers[providerId];
        return provider ? provider.name : providerId;
    }

    /**
     * Validate provider configuration requirements
     */
    validateProviderConfig(
        providerId: string,
        config: { apiKey?: string; baseURL?: string },
    ): { isValid: boolean; errors: string[] } {
        const provider = this.providers[providerId];
        const errors: string[] = [];

        if (!provider) {
            errors.push(`Provider '${providerId}' is not supported`);
            return { isValid: false, errors };
        }

        if (provider.requiresApiKey && !config.apiKey) {
            errors.push(`API key is required for ${provider.name}`);
        }

        if (provider.requiresBaseUrl && !config.baseURL) {
            errors.push(`Base URL is required for ${provider.name}`);
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    }
}
