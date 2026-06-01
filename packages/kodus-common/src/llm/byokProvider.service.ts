import { Injectable } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Callbacks } from '@langchain/core/callbacks/manager';
import { getAdapter } from './providerAdapters/index';

export enum BYOKProvider {
    OPENAI = 'openai',
    ANTHROPIC = 'anthropic',
    GOOGLE_GEMINI = 'google_gemini',
    GOOGLE_VERTEX = 'google_vertex',
    AMAZON_BEDROCK = 'amazon_bedrock',
    OPENAI_COMPATIBLE = 'openai_compatible',
    OPEN_ROUTER = 'open_router',
    NOVITA = 'novita',
}

export interface BYOKConfig {
    main: {
        provider: BYOKProvider;
        apiKey: string;
        model: string;
        baseURL?: string;
        disableReasoning?: boolean;
        /** Reasoning effort level: none disables thinking, low/medium/high
         *  map to provider-specific reasoning config (budget_tokens for
         *  Claude, thinkingBudget for Gemini, reasoningEffort for OpenAI).
         *  When set, takes precedence over disableReasoning. */
        reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
        /** Raw JSON override for provider-specific reasoning config.
         *  When set, takes precedence over reasoningEffort preset. */
        reasoningConfigOverride?: string;
        temperature?: number;
        maxInputTokens?: number;
        maxConcurrentRequests?: number;
        maxOutputTokens?: number;
        /** Google Vertex AI region (e.g. "us-central1"). When omitted,
         *  defaults to env var API_VERTEX_AI_LOCATION then "us-central1". */
        vertexLocation?: string;
        /** Amazon Bedrock API key (bearer token). When set, takes
         *  precedence over SigV4 IAM credentials below. This is the
         *  recommended auth for Bedrock. */
        awsBearerToken?: string;
        /** Advanced: static IAM user credentials for Amazon Bedrock
         *  (SigV4). Used only when awsBearerToken is not set. */
        awsAccessKeyId?: string;
        awsSecretAccessKey?: string;
        awsRegion?: string;
        awsSessionToken?: string;
    };
    fallback?: {
        provider: BYOKProvider;
        apiKey: string;
        model: string;
        baseURL?: string;
        temperature?: number;
        maxInputTokens?: number;
        maxConcurrentRequests?: number;
        maxOutputTokens?: number;
        vertexLocation?: string;
        awsBearerToken?: string;
        awsAccessKeyId?: string;
        awsSecretAccessKey?: string;
        awsRegion?: string;
        awsSessionToken?: string;
    };
}

@Injectable()
export class BYOKProviderService {
    /**
     * Creates a BYOK provider instance based on configuration
     */
    createBYOKProvider(
        config: BYOKConfig,
        options?: {
            temperature?: number;
            maxTokens?: number;
            callbacks?: Callbacks;
            jsonMode?: boolean;
            maxReasoningTokens?: number;
            reasoningLevel?: 'low' | 'medium' | 'high';
            disableReasoning?: boolean;
        },
    ): BaseChatModel {
        const {
            provider,
            apiKey,
            model,
            baseURL,
            disableReasoning,
            reasoningEffort,
        } = config.main;
        const adapter = getAdapter(provider);

        // Map config.main.reasoningEffort to reasoningLevel if caller didn't provide one
        const resolvedReasoningLevel =
            options?.reasoningLevel ??
            (reasoningEffort && reasoningEffort !== 'none'
                ? reasoningEffort
                : undefined);

        if (provider === BYOKProvider.OPENAI_COMPATIBLE && !baseURL) {
            throw new Error(
                'baseURL is required for OpenAI Compatible provider',
            );
        }

        const modelInstance = adapter.build({
            model,
            apiKey,
            baseURL:
                provider === BYOKProvider.OPENAI_COMPATIBLE
                    ? baseURL
                    : provider === BYOKProvider.OPEN_ROUTER
                      ? 'https://openrouter.ai/api/v1'
                      : undefined,
            options: {
                temperature: options?.temperature,
                maxTokens: options?.maxTokens,
                jsonMode: options?.jsonMode,
                maxReasoningTokens: options?.maxReasoningTokens,
                reasoningLevel: resolvedReasoningLevel,
                // Use config.main.disableReasoning or options.disableReasoning
                disableReasoning:
                    reasoningEffort === 'none' ||
                    disableReasoning ||
                    options?.disableReasoning,
                callbacks: options?.callbacks as Callbacks,
            },
        });

        return modelInstance;
    }

    /**
     * Creates a fallback provider if available
     */
    createFallbackProvider(
        config: BYOKConfig,
        options?: {
            temperature?: number;
            maxTokens?: number;
            callbacks?: Callbacks;
            jsonMode?: boolean;
            maxReasoningTokens?: number;
        },
    ): BaseChatModel | null {
        if (!config.fallback) {
            return null;
        }

        // Temporarily replace main config with fallback for creation
        const fallbackConfig: BYOKConfig = {
            main: config.fallback,
        };

        return this.createBYOKProvider(fallbackConfig, options);
    }

    /**
     * Validates if the provider configuration is complete
     */
    validateProviderConfig(providerConfig: {
        region: any;
        projectId: any;
        provider: BYOKProvider;
        apiKey: string;
        model: string;
        baseURL?: string;
    }): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (!providerConfig.provider) {
            errors.push('Provider is required');
        }

        if (!providerConfig.apiKey) {
            errors.push('API key is required');
        }

        if (!providerConfig.model) {
            errors.push('Model is required');
        }

        // Check provider-specific requirements
        if (
            providerConfig.provider === BYOKProvider.OPENAI_COMPATIBLE &&
            !providerConfig.baseURL
        ) {
            errors.push('baseURL is required for OpenAI Compatible provider');
        }

        if (providerConfig.provider === BYOKProvider.GOOGLE_VERTEX) {
            if (!providerConfig.projectId) {
                errors.push('projectId is required for Google Vertex AI');
            }
            if (!providerConfig.region) {
                errors.push('region is required for Google Vertex AI');
            }
            // Validate if apiKey is valid JSON
            try {
                JSON.parse(providerConfig.apiKey);
            } catch {
                errors.push(
                    'apiKey must be a valid JSON service account key for Google Vertex AI',
                );
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    }

    /**
     * Gets the display name for a provider
     */
    getProviderDisplayName(provider: BYOKProvider): string {
        const displayNames = {
            [BYOKProvider.OPENAI]: 'OpenAI',
            [BYOKProvider.ANTHROPIC]: 'Anthropic',
            [BYOKProvider.GOOGLE_GEMINI]: 'Google Gemini',
            [BYOKProvider.GOOGLE_VERTEX]: 'Google Vertex',
            [BYOKProvider.AMAZON_BEDROCK]: 'Amazon Bedrock',
            [BYOKProvider.OPENAI_COMPATIBLE]: 'OpenAI Compatible',
            [BYOKProvider.OPEN_ROUTER]: 'OpenRouter',
            [BYOKProvider.NOVITA]: 'Novita',
        };

        return displayNames[provider] || provider;
    }
}
