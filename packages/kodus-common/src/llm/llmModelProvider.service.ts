import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Runnable } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';
import { Inject, Injectable, LoggerService } from '@nestjs/common';
import { BYOKConfig, BYOKProviderService } from './byokProvider.service';
import {
    FactoryArgs,
    LLMModelProvider,
    MODEL_STRATEGIES,
    getChatGPT,
    getChatVertexAI,
} from './helper';
import { supportsJsonMode } from './providerAdapters';

export type LLMProviderOptions = FactoryArgs & {
    model: LLMModelProvider | string;
    callbacks?: BaseCallbackHandler[];
    maxTokens?: number;
    jsonMode?: boolean;
    maxReasoningTokens?: number;
    disableReasoning?: boolean;
    byokConfig?: BYOKConfig;
};

export type LLMProviderReturn = (BaseChatModel | Runnable) & {
    invoke: (input: any, options?: any) => Promise<any>;
};

@Injectable()
export class LLMProviderService {
    constructor(
        @Inject('LLM_LOGGER')
        private readonly logger: LoggerService,
        private readonly byokProviderService: BYOKProviderService,
    ) {}

    getLLMProvider(options: LLMProviderOptions): LLMProviderReturn {
        try {
            if (options.byokConfig?.main?.apiKey) {
                const byokProvider =
                    this.byokProviderService.createBYOKProvider(
                        options.byokConfig,
                        {
                            ...options,
                            jsonMode: options.jsonMode,
                        },
                    );

                if (
                    options.jsonMode &&
                    byokProvider instanceof ChatOpenAI &&
                    supportsJsonMode(options.byokConfig?.main?.model)
                ) {
                    return byokProvider.withConfig({
                        response_format: { type: 'json_object' },
                    });
                }

                return byokProvider;
            }

            const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';

            if (envMode !== 'auto') {
                // Check if Vertex AI Service Account is configured
                const useVertexAI = !!process.env.API_VERTEX_AI_API_KEY;

                if (useVertexAI) {
                    // Use Vertex AI with Service Account credentials
                    const llm = getChatVertexAI({
                        ...options,
                        model: envMode,
                    });

                    return llm;
                }

                // Fallback to OpenAI-compatible provider
                if (!process.env.API_OPEN_AI_API_KEY) {
                    throw new Error(
                        'API_OPEN_AI_API_KEY or API_VERTEX_AI_API_KEY not configured for self-hosted mode',
                    );
                }

                // Resolve temperature for env-mode self-hosted installs.
                //
                // Order of precedence (highest wins):
                //   1. `API_LLM_TEMPERATURE_OVERRIDE` — explicit operator
                //      override. Set this if the model the operator picked
                //      restricts the allowed range (e.g. reasoning models
                //      that demand `temperature=1`) and they don't want to
                //      patch each prompt. Empty / unparseable values fall
                //      through.
                //   2. Auto-clamp for known reasoning models — Moonshot's
                //      `kimi-k2.6` and `kimi-k2-thinking*` reject any
                //      temperature ≠ 1 with HTTP 400. Most Kodus review
                //      prompts pin `setTemperature(0)` for determinism, so
                //      without this clamp the pipeline 400s mid-review.
                //   3. Whatever the caller passed via `setTemperature()`.
                //
                // Operators who hit a similar restriction on a model not
                // in the auto-clamp regex can bypass it with
                // `API_LLM_TEMPERATURE_OVERRIDE=1` (or any other value
                // their provider accepts).
                const REASONING_TEMP_ONE = /^kimi-k2(\.6|-thinking)/i;
                const overrideRaw = process.env.API_LLM_TEMPERATURE_OVERRIDE;
                const overrideTemp =
                    overrideRaw !== undefined && overrideRaw !== ''
                        ? Number.parseFloat(overrideRaw)
                        : Number.NaN;
                const effectiveTemperature = !Number.isNaN(overrideTemp)
                    ? overrideTemp
                    : REASONING_TEMP_ONE.test(envMode)
                      ? 1
                      : options.temperature;

                const llm = getChatGPT({
                    ...options,
                    model: envMode,
                    temperature: effectiveTemperature,
                    baseURL: process.env.API_OPENAI_FORCE_BASE_URL,
                    apiKey: process.env.API_OPEN_AI_API_KEY,
                });

                return options.jsonMode && supportsJsonMode(envMode)
                    ? llm.withConfig({
                          response_format: { type: 'json_object' },
                      })
                    : llm;
            }

            /** Cloud mode – follows the strategy table */
            const strategy =
                MODEL_STRATEGIES[options.model as LLMModelProvider];
            if (!strategy) {
                this.logger.error({
                    message: `Unsupported provider: ${options.model}`,
                    error: new Error(`Unsupported provider: ${options.model}`),
                    metadata: {
                        requestedModel: options.model,
                        temperature: options.temperature,
                        maxTokens: options.maxTokens,
                        jsonMode: options.jsonMode,
                        maxReasoningTokens: options.maxReasoningTokens,
                    },
                    context: LLMProviderService.name,
                });

                // Use Vertex AI if configured, otherwise fallback to OpenAI
                const useVertexAI = !!process.env.API_VERTEX_AI_API_KEY;
                if (useVertexAI) {
                    return getChatVertexAI({
                        ...options,
                        model: MODEL_STRATEGIES[
                            LLMModelProvider.VERTEX_GEMINI_2_5_FLASH
                        ].modelName,
                    });
                }

                const llm = getChatGPT({
                    ...options,
                    model: MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4O]
                        .modelName,
                    apiKey: process.env.API_OPEN_AI_API_KEY,
                });

                return options.jsonMode &&
                    supportsJsonMode(
                        MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4O]
                            .modelName,
                    )
                    ? llm.withConfig({
                          response_format: { type: 'json_object' },
                      })
                    : llm;
            }

            const { factory, modelName, baseURL } = strategy;

            let llm = factory({
                ...options,
                model: modelName,
                baseURL,
                json: options.jsonMode,
                maxReasoningTokens:
                    options.maxReasoningTokens ?? strategy.maxReasoningTokens,
            });

            if (
                options.jsonMode &&
                this.isOpenAI(llm, strategy.provider) &&
                supportsJsonMode(modelName)
            ) {
                llm = llm.withConfig({
                    response_format: { type: 'json_object' },
                });
            }

            return llm;
        } catch (error) {
            if (options.byokConfig?.main?.apiKey) {
                this.logger.error({
                    message: 'BYOK provider failed - propagating error',
                    metadata: {
                        attemptedModel: options.model,
                        byokProvider: options.byokConfig.main.provider,
                    },
                    context: LLMProviderService.name,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                });
                throw error;
            }

            // Para outros erros (cloud/self-hosted), usa fallback
            this.logger.error({
                message: 'Error getting LLM provider - using fallback',
                metadata: {
                    attemptedModel: options.model,
                    attemptedTemperature: options.temperature,
                    attemptedMaxTokens: options.maxTokens,
                    attemptedJsonMode: options.jsonMode,
                },
                context: LLMProviderService.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
            });

            // Use Vertex AI if configured, otherwise fallback to OpenAI
            const useVertexAI = !!process.env.API_VERTEX_AI_API_KEY;
            if (useVertexAI) {
                return getChatVertexAI({
                    ...options,
                    model: MODEL_STRATEGIES[
                        LLMModelProvider.VERTEX_GEMINI_2_5_FLASH
                    ].modelName,
                });
            }

            const llm = getChatGPT({
                ...options,
                model: MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4O]
                    .modelName,
                apiKey: process.env.API_OPEN_AI_API_KEY,
            });

            return options.jsonMode &&
                supportsJsonMode(
                    MODEL_STRATEGIES[LLMModelProvider.OPENAI_GPT_4O].modelName,
                )
                ? llm.withConfig({ response_format: { type: 'json_object' } })
                : llm;
        }
    }

    private isOpenAI(
        llm: BaseChatModel | Runnable,
        provider: string,
    ): llm is ChatOpenAI {
        return llm instanceof ChatOpenAI || provider === 'openai';
    }
}
