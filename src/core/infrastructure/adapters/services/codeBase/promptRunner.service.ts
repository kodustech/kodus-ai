import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import {
    getChatGemini,
    getDeepseekByNovitaAI,
} from '@/shared/utils/langchainCommon/document';
import { tryParseJSONObject } from '@/shared/utils/transforms/json';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { PinoLoggerService } from '../logger/pino.service';
import { Injectable } from '@nestjs/common';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';

// Interface for token tracking
interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    model?: string;
    runId?: string;
    parentRunId?: string;
}

class TokenTrackingHandlerService extends BaseCallbackHandler {
    name = 'TokenTrackingHandler';
    tokenUsages: TokenUsage[] = [];

    private extractUsageMetadata(output: any): TokenUsage {
        try {
            // Attempts to extract information from different locations in the response
            const usage: TokenUsage = {};

            // Extracts token information
            if (output?.llmOutput?.tokenUsage) {
                Object.assign(usage, output.llmOutput.tokenUsage);
            } else if (output?.llmOutput?.usage) {
                Object.assign(usage, output.llmOutput.usage);
            } else if (output?.generations?.[0]?.[0]?.message?.usage_metadata) {
                const metadata =
                    output.generations[0][0].message.usage_metadata;
                usage.input_tokens = metadata.input_tokens;
                usage.output_tokens = metadata.output_tokens;
                usage.total_tokens = metadata.total_tokens;
            }

            // Extracts model
            usage.model =
                output?.llmOutput?.model ||
                output?.generations?.[0]?.[0]?.message?.response_metadata
                    ?.model ||
                'unknown';

            return usage;
        } catch (error) {
            console.error('Error extracting usage metadata:', error);
            return {};
        }
    }

    async handleLLMEnd(
        output: any,
        runId: string,
        parentRunId?: string,
        tags?: string[],
    ) {
        const usage = this.extractUsageMetadata(output);

        if (Object.keys(usage).length > 0) {
            this.tokenUsages.push({
                ...usage,
                runId,
                parentRunId,
            });
        }
    }

    getTokenUsages(): TokenUsage[] {
        return this.tokenUsages;
    }

    reset() {
        this.tokenUsages = [];
    }
} // set the LANGSMITH_API_KEY environment variable (create key in settings)

type SystemPromptFn = () => string;
type UserPromptFn = (input: any) => string;

@Injectable()
export class PromptRunnerService {
    private readonly tokenTracker: TokenTrackingHandlerService;

    constructor(private readonly logger: PinoLoggerService) {
        this.tokenTracker = new TokenTrackingHandlerService();
    }

    async runPrompt(params: {
        payload: any;
        provider: LLMModelProvider;
        fallbackProvider: LLMModelProvider;
        context?: any;
        systemPromptFn: SystemPromptFn;
        userPromptFn: UserPromptFn;
        runName?: string;
    }) {
        try {
            const { payload } = params;

            const chain = await this.createChainWithFallback(params);

            const response = await chain.invoke(payload);

            return this.processLLMResponse({ response });
        } catch (error) {
            this.logger.error({
                message: `Error running prompt: ${params.runName}`,
                error,
                context: PromptRunnerService.name,
                metadata: params,
            });
            return null;
        }
    }

    async createChainWithFallback(params: {
        provider: LLMModelProvider;
        fallbackProvider: LLMModelProvider;
        context?: any;
        systemPromptFn: SystemPromptFn;
        userPromptFn: UserPromptFn;
        runName?: string;
    }) {
        try {
            const {
                provider,
                fallbackProvider,
                context,
                systemPromptFn,
                userPromptFn,
                runName,
            } = params;

            const mainChain = await this.createProviderChain({
                provider,
                context,
                systemPromptFn: systemPromptFn,
                userPromptFn: userPromptFn,
            });

            const fallbackChain = await this.createProviderChain({
                provider: fallbackProvider,
                context,
                systemPromptFn: systemPromptFn,
                userPromptFn: userPromptFn,
            });

            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName,
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating chain with fallback',
                error,
                context: PromptRunnerService.name,
                metadata: params,
            });
            throw error;
        }
    }

    private async createProviderChain(params: {
        provider: LLMModelProvider;
        context?: any;
        systemPromptFn: SystemPromptFn;
        userPromptFn: UserPromptFn;
    }) {
        try {
            const { provider, context, systemPromptFn, userPromptFn } = params;

            let llm;
            switch (provider) {
                case LLMModelProvider.GEMINI_1_5_PRO:
                    llm = getChatGemini({
                        model: LLMModelProvider.GEMINI_1_5_PRO,
                        temperature: 0,
                        callbacks: [this.tokenTracker],
                    });
                    break;
                case LLMModelProvider.GEMINI_2_0_FLASH:
                    llm = getChatGemini({
                        model: LLMModelProvider.GEMINI_2_0_FLASH,
                        temperature: 0,
                        callbacks: [this.tokenTracker],
                    });
                    break;
                case LLMModelProvider.DEEPSEEK_V3:
                    llm = getDeepseekByNovitaAI({
                        temperature: 0,
                        callbacks: [this.tokenTracker],
                    });
                    break;
                default:
                    throw new Error('Provider not supported');
            }

            // Create the chain using the correct provider
            const chain = RunnableSequence.from([
                async (input: any) => {
                    const systemPrompt = systemPromptFn();
                    const humanPrompt = userPromptFn(input);

                    return [
                        {
                            role: 'system',
                            content: [
                                {
                                    type: 'text',
                                    text: systemPrompt,
                                },
                            ],
                        },
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: humanPrompt,
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating provider chain',
                error,
                context: PromptRunnerService.name,
                metadata: params,
            });
            throw error;
        }
    }

    private processLLMResponse(params: { response: string }) {
        try {
            const { response } = params;

            let cleanResponse = response;
            if (response?.startsWith('```')) {
                cleanResponse = response
                    .replace(/^```json\n/, '')
                    .replace(/\n```(\n)?$/, '')
                    .trim();
            }

            return tryParseJSONObject(cleanResponse);
        } catch (error) {
            this.logger.error({
                message: 'Error parsing LLM response',
                context: PromptRunnerService.name,
                error: error,
                metadata: params,
            });
            return null;
        }
    }
}
