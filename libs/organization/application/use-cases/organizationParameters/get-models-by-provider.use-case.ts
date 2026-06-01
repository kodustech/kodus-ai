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
                return this.getVertexModels(process.env.API_GOOGLE_AI_API_KEY);

            case BYOKProvider.OPEN_ROUTER:
                return this.getOpenRouterModels(
                    process.env.API_OPEN_ROUTER_API_KEY,
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

    private async getVertexModels(apiKey?: string): Promise<ModelResponse> {
        try {
            if (!apiKey) {
                throw new BadRequestException(
                    'API key is required for Google Vertex',
                );
            }

            this.logger.debug({
                message: 'Fetching Vertex models',
                context: GetModelsByProviderUseCase.name,
                metadata: {
                    apiKeyPrefix: apiKey.substring(0, 10) + '...',
                },
            });

            // Use Gemini API to list models and map to Vertex
            const response = await axios.get<GeminiResponse>(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
            );

            this.logger.debug({
                message: 'Gemini response received',
                context: GetModelsByProviderUseCase.name,
                metadata: {
                    modelCount: response.data.models?.length || 0,
                },
            });

            return {
                provider: BYOKProvider.GOOGLE_VERTEX,
                models: response.data.models
                    .filter(
                        (model: GeminiModel) =>
                            model.name.includes('gemini') &&
                            model.supportedGenerationMethods.includes(
                                'generateContent',
                            ),
                    )
                    .map((model: GeminiModel) => ({
                        id: model.name.split('/')[1],
                        name: `Vertex ${model.displayName || model.name}`,
                    })),
            };
        } catch (error) {
            this.logger.error({
                message: 'Error fetching Vertex models',
                context: GetModelsByProviderUseCase.name,
                error: error,
            });
            throw new BadRequestException(
                `Error fetching Google Vertex models: ${(error as Error).message}`,
            );
        }
    }
}
