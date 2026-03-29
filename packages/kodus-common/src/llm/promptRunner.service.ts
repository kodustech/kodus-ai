import { Inject, Injectable, LoggerService } from '@nestjs/common';
import {
    LLMProviderOptions,
    LLMProviderService,
} from './llmModelProvider.service';
import { RunnableConfig, RunnableSequence } from '@langchain/core/runnables';
import { handleError } from '../utils/error';
import { PromptBuilder } from './builder';
import { LLMModelProvider } from './helper';
import { BaseOutputParser } from '@langchain/core/output_parsers';
import {
    BaseMessage,
    BaseMessageLike,
    isBaseMessage,
} from '@langchain/core/messages';
import { BYOKConfig } from './byokProvider.service';
import { LLMErrorNormalizer } from './utils/llm-error-normalizer';
import { LLM_TIMEOUT_MS } from './providerAdapters/types';

export type PromptFn<Payload> = (input: Payload) => string;

export enum PromptRole {
    SYSTEM = 'system',
    USER = 'user',
    AI = 'ai',
    CUSTOM = 'custom',
}

export enum PromptScope {
    GLOBAL = 'global',
    MAIN = 'main',
    FALLBACK = 'fallback',
}

export type PromptConfig<Payload> = {
    role?: PromptRole;
    roleName?: string;
    prompt: PromptFn<Payload> | string | BaseMessage;
    type?: string;
    scope?: PromptScope;
};

export type PromptRunnerParams<Payload, OutputType = any> = {
    provider: LLMModelProvider;
    fallbackProvider?: LLMModelProvider;
    parser: BaseOutputParser<OutputType>;
    prompts: PromptConfig<Payload>[];
    payload?: Payload;
    byokConfig?: BYOKConfig;
    byokFallbackConfig?: BYOKConfig;
} & Partial<Omit<LLMProviderOptions, 'model'>> &
    /** Options passed to the `withConfig` langchain method */
    Partial<RunnableConfig>;

/**
 * A service for running prompts with a language model provider.
 *
 * This service allows you to run prompts with a specified provider,
 * fallback provider, and parser. It supports various configurations
 * such as temperature, JSON mode, and callbacks.
 */
@Injectable()
export class PromptRunnerService {
    constructor(
        @Inject('LLM_LOGGER')
        private readonly logger: LoggerService,

        private readonly llmProvider: LLMProviderService,
    ) {}

    /**
     * Creates a new instance of PromptBuilder.
     *
     * @returns A new PromptBuilder instance.
     */
    builder(): PromptBuilder {
        return new PromptBuilder(this);
    }

    /**
     * Runs a prompt with the provided parameters.
     *
     * If `jsonMode` is set to `true`, the output will be parsed as JSON.
     * If `jsonMode` is `false` or not set, the output will be returned as a string.
     *
     * @param params The parameters for running the prompt.
     * @template Payload The type of the payload that will be passed to the prompt functions.
     * @template OutputType The expected response type, which can be a string or JSON object.
     * @returns A promise that resolves to the output of the prompt execution. If the prompt fails, it returns `null`.
     */
    async runPrompt<Payload = void, OutputType = any>(
        params: PromptRunnerParams<Payload, OutputType> & {
            jsonMode: true;
        },
    ): Promise<OutputType | null>;

    async runPrompt<Payload = void, OutputType = string>(
        params: Omit<PromptRunnerParams<Payload, OutputType>, 'jsonMode'>,
    ): Promise<OutputType | null>;

    async runPrompt<Payload = void, OutputType = string>(
        params: PromptRunnerParams<Payload, OutputType> & {
            jsonMode?: false | undefined;
        },
    ): Promise<OutputType | null>;

    async runPrompt<Payload = void, OutputType = any>(
        params: PromptRunnerParams<Payload, OutputType>,
    ): Promise<OutputType | null> {
        try {
            this.validateParams(params);

            const chain = this.createChain<Payload, OutputType>(params);

            const response = await this.invokeWithTimeout(
                chain,
                params.payload ?? ({} as Payload),
                params.runName,
            );

            return response;
        } catch (error) {
            const normalized = LLMErrorNormalizer.normalize(error);
            this.logger.error({
                message: `Error running prompt: ${params.runName}`,
                error: normalized,
                context: PromptRunnerService.name,
                metadata: params,
            });
            throw normalized;
        }
    }

    /**
     * Wraps chain.invoke with an application-level timeout.
     * This is a safety net for cases where the LLM provider SDK timeout
     * does not fire (e.g. OpenRouter keeping connections alive).
     */
    private async invokeWithTimeout<Payload, OutputType>(
        chain: { invoke: (input: Payload) => Promise<OutputType> },
        payload: Payload,
        runName?: string,
    ): Promise<OutputType> {
        const timeoutMs = LLM_TIMEOUT_MS; // 5 minutes

        let timeoutHandle: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(
                    new Error(
                        `LLM call timed out after ${timeoutMs / 1000}s (runName: ${runName ?? 'unknown'}). ` +
                            `The provider did not respond within the allowed time.`,
                    ),
                );
            }, timeoutMs);
        });

        try {
            return await Promise.race([chain.invoke(payload), timeoutPromise]);
        } finally {
            clearTimeout(timeoutHandle!);
        }
    }

    /**
     * Creates a chain of prompts with the specified parameters.
     *
     * @param params The parameters for creating the chain.
     * @template Payload The type of the payload that will be passed to the prompt functions.
     * @template OutputType The expected response type, which can be a string or JSON object
     * @returns A chain that can be invoked with a payload.
     * @throws Will throw an error if the parameters are invalid or if the chain creation fails
     */
    createChain<Payload, OutputType>(
        params: PromptRunnerParams<Payload, OutputType>,
    ) {
        try {
            this.validateParams(params);

            const { fallbackProvider, byokConfig, byokFallbackConfig } = params;

            const mainChain = this.createProviderChain<Payload, OutputType>(
                params,
            );
            if (!mainChain) {
                throw new Error('Main chain could not be created');
            }

            // Se não houver fallback / byokFallback, só retorna mainChain ou com config,
            // mas se byokConfig existir, evitar aplicar withConfig
            if (!fallbackProvider && !byokFallbackConfig) {
                const sanitizedParams = { ...params };

                if (byokConfig) {
                    delete sanitizedParams?.maxReasoningTokens;
                    delete sanitizedParams?.byokConfig;
                    delete sanitizedParams?.byokFallbackConfig;
                    delete sanitizedParams?.jsonMode;
                    delete sanitizedParams?.json;
                }

                return mainChain.withConfig(sanitizedParams);
            }

            const fallbackChain = this.createProviderChain<Payload, OutputType>(
                params,
                true,
            );
            if (!fallbackChain) {
                throw new Error('Fallback chain could not be created');
            }

            const withFallbacks = mainChain.withFallbacks({
                fallbacks: [fallbackChain],
            });

            const sanitizedParams = { ...params };

            if (byokConfig) {
                delete sanitizedParams?.maxReasoningTokens;
                delete sanitizedParams?.byokConfig;
                delete sanitizedParams?.byokFallbackConfig;
                delete sanitizedParams?.jsonMode;
                delete sanitizedParams?.json;
            }

            return withFallbacks.withConfig(sanitizedParams);
        } catch (error) {
            this.logger.error({
                message: 'Error creating chain',
                error: handleError(error),
                context: PromptRunnerService.name,
                metadata: params,
            });
            throw error;
        }
    }

    /**
     * Creates a provider chain with the specified parameters.
     *
     * @param params The parameters for creating the provider chain.
     * @template Payload The type of the payload that will be passed to the prompt functions.
     * @template OutputType The expected response type, which can be a string or JSON object
     * @returns A chain that can be invoked with a payload.
     * @throws Will throw an error if the parameters are invalid or if the chain creation fails
     */
    createProviderChain<Payload, OutputType>(
        params: PromptRunnerParams<Payload, OutputType>,
        fallback?: boolean,
    ) {
        try {
            this.validateParams(params);

            const {
                provider,
                fallbackProvider,
                prompts = [],
                temperature = 0,
                parser,
            } = params;

            const providerToUse =
                fallback && fallbackProvider ? fallbackProvider : provider;

            const byokConfig = fallback
                ? params.byokFallbackConfig
                : params.byokConfig;

            const llm = this.llmProvider.getLLMProvider({
                ...params,
                model: providerToUse,
                temperature,
                byokConfig,
            });

            const promptFn = (input: Payload) => {
                const result: BaseMessageLike[] = [];

                for (const prompt of prompts) {
                    const {
                        role: promptRole = PromptRole.USER,
                        roleName: promptRoleName,
                        prompt: promptContent,
                        type = 'text',
                        scope = PromptScope.GLOBAL,
                    } = prompt;

                    if (scope === PromptScope.FALLBACK && !fallback) {
                        continue; // Skip fallback prompts if not in fallback mode
                    }

                    if (scope === PromptScope.MAIN && fallback) {
                        continue; // Skip main prompts if in fallback mode
                    }

                    let role: string;
                    if (promptRole === PromptRole.CUSTOM) {
                        if (!promptRoleName) {
                            throw new Error(
                                'Custom prompt roles must have a roleName defined.',
                            );
                        }
                        role = promptRoleName;
                    } else {
                        role = promptRole;
                    }

                    let text: string;
                    switch (typeof promptContent) {
                        case 'function':
                            text = promptContent(input);
                            break;
                        case 'string':
                            text = promptContent;
                            break;
                        default:
                            if (isBaseMessage(promptContent)) {
                                result.push(promptContent);
                                continue; // Skip to next prompt
                            }

                            throw new Error(
                                'Prompt must be a string or a function returning a string.',
                            );
                    }

                    if (typeof text !== 'string') {
                        throw new Error(
                            `Prompt must resolve to a string (role: ${role}).`,
                        );
                    }

                    const normalizedText = text.trim();
                    if (!normalizedText) {
                        throw new Error(
                            `Prompt content is empty (role: ${role}).`,
                        );
                    }

                    result.push({
                        role,
                        content: [
                            {
                                type,
                                text: normalizedText,
                            },
                        ],
                    });
                }

                if (result.length === 0) {
                    throw new Error('No prompt content provided');
                }

                return result;
            };

            const chain = RunnableSequence.from([promptFn, llm, parser]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating provider chain',
                error: handleError(error),
                context: PromptRunnerService.name,
                metadata: params,
            });
            throw error;
        }
    }

    /**
     * Validates the parameters for running a prompt.
     *
     * @param params The parameters to validate.
     * @template Payload The type of the payload that will be passed to the prompt functions.
     * @throws Will throw an error if any required parameter is missing or invalid.
     * @returns void
     */
    private validateParams<Payload>(
        params: PromptRunnerParams<Payload>,
    ): asserts params is PromptRunnerParams<Payload> {
        // BYOK é opcional, então ajustar validação
        if (!params.provider && !params.byokConfig) {
            throw new Error(
                'Provider or BYOK config must be defined in the parameters.',
            );
        }
        if (!params.parser) {
            throw new Error('Parser must be defined in the parameters.');
        }
        if (!params.prompts || params.prompts.length === 0) {
            throw new Error('No prompts defined.');
        }
    }
}
