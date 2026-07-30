import { Injectable } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Callbacks } from '@langchain/core/callbacks/manager';
import { getAdapter } from './providerAdapters/index';
import { VertexAnthropicAdapter } from './providerAdapters/vertexAnthropicAdapter';

/** Claude model ids (e.g. claude-sonnet-4-6, claude-haiku-4-5@20251001). */
const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;

export enum BYOKProvider {
    OPENAI = 'openai',
    ANTHROPIC = 'anthropic',
    GOOGLE_GEMINI = 'google_gemini',
    GOOGLE_VERTEX = 'google_vertex',
    AMAZON_BEDROCK = 'amazon_bedrock',
    OPENAI_COMPATIBLE = 'openai_compatible',
    ANTHROPIC_COMPATIBLE = 'anthropic_compatible',
    OPEN_ROUTER = 'open_router',
    NOVITA = 'novita',
}

/**
 * Normalize an Anthropic-compatible base URL to its root form (no trailing
 * slash, no `/v1` suffix). The two Anthropic SDK paths disagree on shape:
 * LangChain's ChatAnthropic appends `/v1/messages` to the root, while
 * `@ai-sdk/anthropic` appends `/messages` to a `/v1`-suffixed base. Users
 * paste either shape (e.g. `https://api.kimi.com/coding` or
 * `https://api.kimi.com/coding/v1`), so each call site normalizes from the
 * root: LangChain uses it as-is, Vercel appends `/v1`.
 */
export function anthropicCompatibleRootURL(baseURL: string): string {
    let trimmed = baseURL.trim();
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    if (/\/v1$/i.test(trimmed)) trimmed = trimmed.slice(0, -3);
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    return trimmed;
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
            vertexLocation,
            disableReasoning,
            reasoningEffort,
        } = config.main;
        // Claude on Vertex needs the Anthropic protocol, which the Gemini-only
        // ChatVertexAI can't speak — route it to the Vertex-Anthropic adapter.
        const adapter =
            provider === BYOKProvider.GOOGLE_VERTEX &&
            CLAUDE_MODEL_PATTERN.test(model)
                ? new VertexAnthropicAdapter()
                : getAdapter(provider);

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

        if (provider === BYOKProvider.ANTHROPIC_COMPATIBLE && !baseURL) {
            throw new Error(
                'baseURL is required for Anthropic Compatible provider',
            );
        }

        const modelInstance = adapter.build({
            model,
            apiKey,
            vertexLocation,
            baseURL:
                provider === BYOKProvider.OPENAI_COMPATIBLE ||
                provider === BYOKProvider.ANTHROPIC_COMPATIBLE
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

        if (
            providerConfig.provider === BYOKProvider.ANTHROPIC_COMPATIBLE &&
            !providerConfig.baseURL
        ) {
            errors.push(
                'baseURL is required for Anthropic Compatible provider',
            );
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
            [BYOKProvider.ANTHROPIC_COMPATIBLE]: 'Anthropic Compatible',
            [BYOKProvider.OPEN_ROUTER]: 'OpenRouter',
            [BYOKProvider.NOVITA]: 'Novita',
        };

        return displayNames[provider] || provider;
    }
}
