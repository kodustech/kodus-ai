import {
    BYOKProvider,
    getModelCapabilities,
    ReasoningConfig,
} from '@kodus/kodus-common/llm';
import { ProviderService } from '@libs/core/infrastructure/services/providers/provider.service';
import { createLogger } from '@kodus/flow';
import { BadRequestException, Injectable } from '@nestjs/common';
import axios from 'axios';

// Interfaces for API responses
interface OpenAIModel {
    id: string;
    object: string;
    created: number;
    owned_by: string;
}

interface OpenAIResponse {
    object: string;
    data: OpenAIModel[];
}

interface AnthropicModel {
    id: string;
    display_name?: string;
    context_length: number;
    pricing: {
        prompt: string;
        completion: string;
    };
}

interface AnthropicResponse {
    data: AnthropicModel[];
}

interface GeminiModel {
    name: string;
    displayName?: string;
    description?: string;
    supportedGenerationMethods: string[];
}

interface GeminiResponse {
    models: GeminiModel[];
}

export interface ModelResponse {
    provider: BYOKProvider;
    models: Array<{
        id: string;
        name: string;
        supportsReasoning?: boolean;
        reasoningConfig?: ReasoningConfig;
    }>;
}

@Injectable()
export class GetModelsByProviderUseCase {
    private readonly logger = createLogger(GetModelsByProviderUseCase.name);

    constructor(private readonly providerService: ProviderService) {}

    async execute(provider: string): Promise<ModelResponse> {
        if (!this.providerService.isProviderSupported(provider)) {
            throw new BadRequestException(`Unsupported provider: ${provider}`);
        }

        const byokProvider = provider as BYOKProvider;

        switch (byokProvider) {
            case BYOKProvider.OPENAI:
                return this.getOpenAIModels(process.env.API_OPEN_AI_API_KEY);

            case BYOKProvider.ANTHROPIC:
                return this.getAnthropicModels(
                    process.env.API_ANTHROPIC_API_KEY,
                );

            case BYOKProvider.GOOGLE_GEMINI:
                return this.getGeminiModels(process.env.API_GOOGLE_AI_API_KEY);

            case BYOKProvider.GOOGLE_VERTEX:
                return this.getVertexModels();

            case BYOKProvider.OPEN_ROUTER:
                return this.getOpenRouterModels(
                    process.env.API_OPEN_ROUTER_API_KEY,
                );

            case BYOKProvider.REQUESTY:
                return this.getRequestyModels(
                    process.env.API_REQUESTY_API_KEY,
                );

            case BYOKProvider.NOVITA:
                return this.getNovitaModels(process.env.API_NOVITA_AI_API_KEY);

            case BYOKProvider.OPENAI_COMPATIBLE:
                return this.getOpenAICompatibleModels(
                    process.env.API_OPEN_AI_API_KEY,
                    process.env.API_OPENAI_FORCE_BASE_URL ||
                        'https://api.openai.com',
                );

            case BYOKProvider.AMAZON_BEDROCK:
                return this.getBedrockModels();

            case BYOKProvider.ANTHROPIC_COMPATIBLE:
                // Listing needs the user's baseURL + key, which aren't
                // available here; the frontend forces free-form model input
                // for baseURL-requiring providers, so this is never called
                // in the normal flow.
                throw new BadRequestException(
                    'Model listing is not available for anthropic_compatible — enter the model ID manually.',
                );

            default:
                throw new BadRequestException(
                    `Unsupported provider: ${provider}`,
                );
        }
    }

    /**
     * Bedrock model IDs are region-scoped and cross-region inference
     * profiles vary by AWS account. We can't list them generically without
     * the user's AWS credentials (which are entered later in the wizard),
     * so this returns a curated set of "us.*" cross-region inference
     * profiles that cover the most common code-review use cases.
     *
     * Users on eu/apac regions or with custom inference profiles can still
     * paste a model ID manually — the frontend allows free-form input on
     * the Bedrock model field.
     */
    private getBedrockModels(): ModelResponse {
        // Lookup by the Anthropic-style suffix (everything after
        // "us.anthropic.") so we still pick up reasoning config from
        // getModelCapabilities even though the catalog ID is prefixed.
        const reasoningKeyOf = (id: string): string => {
            const match = id.match(/^[a-z]{2,5}\.anthropic\.(.+?)-v\d+:\d+$/);
            return match ? match[1] : id;
        };

        const catalog: Array<{ id: string; name: string }> = [
            {
                id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                name: 'Claude Sonnet 4.5 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
                name: 'Claude Sonnet 4 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
                name: 'Claude Opus 4.1 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-opus-4-20250514-v1:0',
                name: 'Claude Opus 4 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
                name: 'Claude 3.7 Sonnet (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                name: 'Claude 3.5 Sonnet v2 (us, cross-region)',
            },
            {
                id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
                name: 'Claude 3.5 Haiku (us, cross-region)',
            },
        ];

        return {
            provider: BYOKProvider.AMAZON_BEDROCK,
            models: catalog.map(({ id, name }) => {
                const capabilities = getModelCapabilities(reasoningKeyOf(id));
                return {
                    id,
                    name,
                    ...(capabilities.supportsReasoning && {
                        supportsReasoning: true,
                        reasoningConfig: capabilities.reasoningConfig,
                    }),
                };
            }),
        };
    }

    private async getOpenAIModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://api.openai.com/v1/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            const models = {
                provider: BYOKProvider.OPENAI,
                models: response.data.data.map((model: OpenAIModel) => {
                    const capabilities = getModelCapabilities(model.id);
                    const modelResult = {
                        id: model.id,
                        name: model.id,
                        ...(capabilities.supportsReasoning && {
                            supportsReasoning: true,
                            reasoningConfig: capabilities.reasoningConfig,
                        }),
                    };

                    return modelResult;
                }),
            };

            return models;
        } catch (error) {
            throw new BadRequestException(
                `Error fetching OpenAI models: ${(error as Error).message}`,
            );
        }
    }

    private async getAnthropicModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<AnthropicResponse>(
                'https://api.anthropic.com/v1/models',
                {
                    headers: {
                        'x-api-key': apiKey,
                        'anthropic-version': '2023-06-01',
                        'Content-Type': 'application/json',
                    },
                },
            );

            return {
                provider: BYOKProvider.ANTHROPIC,
                models: response.data.data.map((model: AnthropicModel) => ({
                    id: model.id,
                    name: model.display_name || model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching Anthropic models: ${(error as Error).message}`,
            );
        }
    }

    private async getGeminiModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<GeminiResponse>(
                'https://generativelanguage.googleapis.com/v1beta/models',
                {
                    headers: {
                        'x-goog-api-key': apiKey,
                    },
                    timeout: 10000, // 10 segundos timeout
                },
            );

            const models = {
                provider: BYOKProvider.GOOGLE_GEMINI,
                models: response.data.models
                    .filter((model: GeminiModel) =>
                        model.name.includes('gemini'),
                    )
                    .map((model: GeminiModel) => {
                        const modelId = model.name.split('/')[1];
                        const capabilities = getModelCapabilities(modelId);

                        const formatModelName = (str: string): string => {
                            return str
                                .split('-')
                                .map((word, index) => {
                                    if (index === 0) {
                                        // First word always capitalized
                                        return (
                                            word.charAt(0).toUpperCase() +
                                            word.slice(1).toLowerCase()
                                        );
                                    }
                                    // Numbers with dots stay as they are
                                    if (/^\d+\.\d+$/.test(word)) {
                                        return word;
                                    }
                                    // Other words capitalize first letter
                                    return (
                                        word.charAt(0).toUpperCase() +
                                        word.slice(1).toLowerCase()
                                    );
                                })
                                .join(' ');
                        };

                        return {
                            id: modelId,
                            name: formatModelName(modelId),
                            ...(capabilities.supportsReasoning && {
                                supportsReasoning: true,
                                reasoningConfig: capabilities.reasoningConfig,
                            }),
                        };
                    }),
            };

            return models;
        } catch (error) {
            throw new BadRequestException(
                `Error fetching Gemini models: ${(error as Error).message}`,
            );
        }
    }
    private async getOpenRouterModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://openrouter.ai/api/v1/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            return {
                provider: BYOKProvider.OPEN_ROUTER,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching OpenRouter models: ${(error as Error).message}`,
            );
        }
    }

    private async getRequestyModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://router.requesty.ai/v1/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            return {
                provider: BYOKProvider.REQUESTY,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching Requesty models: ${(error as Error).message}`,
            );
        }
    }

    private async getNovitaModels(apiKey?: string): Promise<ModelResponse> {
        try {
            const response = await axios.get<OpenAIResponse>(
                'https://api.novita.ai/v3/openai/models',
                {
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );

            return {
                provider: BYOKProvider.NOVITA,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching Novita models: ${(error as Error).message}`,
            );
        }
    }

    private async getOpenAICompatibleModels(
        apiKey?: string,
        baseUrl?: string,
    ): Promise<ModelResponse> {
        if (!baseUrl) {
            throw new BadRequestException(
                'baseUrl is required for OpenAI Compatible',
            );
        }

        try {
            const modelsUrl = baseUrl.endsWith('/')
                ? `${baseUrl}v1/models`
                : `${baseUrl}/v1/models`;

            const response = await axios.get<OpenAIResponse>(modelsUrl, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
            });

            return {
                provider: BYOKProvider.OPENAI_COMPATIBLE,
                models: response.data.data.map((model: OpenAIModel) => ({
                    id: model.id,
                    name: model.id,
                })),
            };
        } catch (error) {
            throw new BadRequestException(
                `Error fetching OpenAI Compatible models: ${(error as Error).message}`,
            );
        }
    }

    /**
     * Vertex models can't be listed generically: per-project/region
     * availability requires the user's service-account JSON, which isn't
     * available to this (GET, credential-less) endpoint. Listing it live
     * would mean putting a sensitive ~3KB SA JSON in a query string.
     *
     * So, like Bedrock, return a curated catalog. It covers both Vertex
     * model families served via different protocols:
     *   - Gemini (`gemini-*`)  → Gemini protocol  (createVertex)
     *   - Claude (`claude-*@…`) → Anthropic protocol on Vertex MaaS
     *                            (createVertexAnthropic)
     * Model-id routing happens in `byok-to-vercel.ts`. Users on other
     * regions or with custom/newer models can still paste a model ID —
     * the Vertex model field allows free-form input.
     *
     * Vertex Claude ID convention (per Anthropic's official Vertex docs):
     * recent models use a bare id (e.g. `claude-opus-4-8`), older ones use
     * the `@<version>` suffix (e.g. `claude-sonnet-4-5@20250929`). Both
     * route through createVertexAnthropic. Catalog reflects models that are
     * current (non-deprecated) on Vertex as of 2026-06.
     */
    private getVertexModels(): ModelResponse {
        const catalog: Array<{ id: string; name: string }> = [
            // gemini-3-pro-preview was discontinued on Vertex (2026-03-26);
            // Google's migration target is gemini-3.1-pro-preview.
            { id: 'gemini-3.1-pro-preview', name: 'Vertex Gemini 3.1 Pro' },
            { id: 'gemini-3.5-flash', name: 'Vertex Gemini 3.5 Flash' },
            { id: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro' },
            { id: 'gemini-2.5-flash', name: 'Vertex Gemini 2.5 Flash' },
            // Only Claude models served by the GLOBAL endpoint (bare ids) are
            // listed, so any catalog pick works with the default global region
            // out of the box. Older @date-suffixed Claude models (Sonnet 4.5,
            // Haiku 4.5, …) are region-only (e.g. us-east5) — users who want
            // those can type the id manually and pin the region.
            { id: 'claude-opus-4-8', name: 'Vertex Claude Opus 4.8' },
            { id: 'claude-opus-4-7', name: 'Vertex Claude Opus 4.7' },
            { id: 'claude-sonnet-4-6', name: 'Vertex Claude Sonnet 4.6' },
        ];

        // Capability lookup keys on a plain model name; strip the Vertex
        // `@<version>` suffix so versioned Claude entries resolve their
        // reasoning config (bare ids pass through unchanged).
        const reasoningKeyOf = (id: string): string => id.split('@')[0];

        return {
            provider: BYOKProvider.GOOGLE_VERTEX,
            models: catalog.map(({ id, name }) => {
                const capabilities = getModelCapabilities(reasoningKeyOf(id));
                return {
                    id,
                    name,
                    ...(capabilities.supportsReasoning && {
                        supportsReasoning: true,
                        reasoningConfig: capabilities.reasoningConfig,
                    }),
                };
            }),
        };
    }
}
