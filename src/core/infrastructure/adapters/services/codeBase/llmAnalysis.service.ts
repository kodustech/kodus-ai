import { Injectable } from '@nestjs/common';
import { IAIAnalysisService } from '../../../../domain/codeBase/contracts/AIAnalysisService.contract';
import {
    FileChangeContext,
    AnalysisContext,
    AIAnalysisResult,
    CodeSuggestion,
    ReviewModeResponse,
    FileChange,
    ISafeguardResponse,
    ReviewModeConfig,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PinoLoggerService } from '../logger/pino.service';
import {
    getChatGemini,
    getChatGPT,
    getChatVertexAI,
    getDeepseekByNovitaAI,
} from '@/shared/utils/langchainCommon/document';
import { RunnableSequence } from '@langchain/core/runnables';
import {
    StringOutputParser,
    StructuredOutputParser,
} from '@langchain/core/output_parsers';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import {
    prompt_codeReviewSafeguard_system,
    prompt_codeReviewSafeguard_user,
} from '@/shared/utils/langchainCommon/prompts/codeReviewSafeguard';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { LLMResponseProcessor } from './utils/transforms/llmResponseProcessor.transform';
import { prompt_validateImplementedSuggestions } from '@/shared/utils/langchainCommon/prompts/validateImplementedSuggestions';
import { prompt_selectorLightOrHeavyMode_system } from '@/shared/utils/langchainCommon/prompts/seletorLightOrHeavyMode';
import {
    prompt_codereview_system_gemini,
    prompt_codereview_user_deepseek,
} from '@/shared/utils/langchainCommon/prompts/configuration/codeReview';
import {
    prompt_severity_analysis_system,
    prompt_severity_analysis_user,
} from '@/shared/utils/langchainCommon/prompts/severityAnalysis';

// Interface for token tracking
interface TokenUsage {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    model?: string;
    runId?: string;
    parentRunId?: string;
}

// Handler for token tracking
class TokenTrackingHandler extends BaseCallbackHandler {
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
}

export const LLM_ANALYSIS_SERVICE_TOKEN = Symbol('LLMAnalysisService');

@Injectable()
export class LLMAnalysisService implements IAIAnalysisService {
    private readonly tokenTracker: TokenTrackingHandler;
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(private readonly logger: PinoLoggerService) {
        this.tokenTracker = new TokenTrackingHandler();
        this.llmResponseProcessor = new LLMResponseProcessor(logger);
    }

    //#region Helper Functions
    // Creates the prefix for the prompt cache (every prompt that uses file or codeDiff must start with this)
    private preparePrefixChainForCache(
        context: {
            patchWithLinesStr: string;
            fileContent: string;
            language: string;
            filePath: string;
        },
        reviewMode: ReviewModeResponse,
    ) {
        if (!context?.patchWithLinesStr) {
            throw new Error('Required context parameters are missing');
        }

        if (reviewMode === ReviewModeResponse.LIGHT_MODE) {
            return {
                type: 'text',
                text: `
                <codeDiff>
                    ${context.patchWithLinesStr}
                </codeDiff>

                <filePath>
                    ${context.filePath}
                </filePath>
                `,
                cache_control: { type: 'ephemeral' },
            };
        }

        return {
            type: 'text',
            text: `
            <fileContent>
                ${context.fileContent}
            </fileContent>

            <codeDiff>
                ${context.patchWithLinesStr}
            </codeDiff>

            <filePath>
                ${context.filePath}
            </filePath>
            `,
            cache_control: { type: 'ephemeral' },
        };
    }

    private async logTokenUsage(metadata: any) {
        // Log token usage for analysis and monitoring
        this.logger.log({
            message: 'Token usage',
            context: LLMAnalysisService.name,
            metadata: {
                ...metadata,
            },
        });
    }
    //#endregion

    //#region Analyze Code with AI
    async analyzeCodeWithAI(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
    ): Promise<AIAnalysisResult> {
        const provider = this.getInitialProvider(context, reviewModeResponse);

        // Reset token tracking for new analysis
        this.tokenTracker.reset();

        // Prepare base context
        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );

        try {
            // Create chain with fallback
            const chain = await this.createAnalysisChainWithFallback(
                provider,
                baseContext,
                reviewModeResponse,
            );

            // Execute analysis
            const result = await chain.invoke(baseContext);

            // Process result and tokens
            const analysisResult = this.llmResponseProcessor.processResponse(
                organizationAndTeamData,
                prNumber,
                result,
            );

            if (!analysisResult) {
                return null;
            }

            analysisResult.codeReviewModelUsed = {
                generateSuggestions: provider,
            };

            return analysisResult;
        } catch (error) {
            this.logger.error({
                message: `Error during LLM code analysis for PR#${prNumber}`,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
                error,
            });
            throw error;
        }
    }

    private async prepareAnalysisContext(
        fileContext: FileChangeContext,
        context: AnalysisContext,
    ) {
        const baseContext = {
            pullRequest: context?.pullRequest,
            patchWithLinesStr: fileContext?.patchWithLinesStr,
            maxSuggestionsParams:
                context.codeReviewConfig?.suggestionControl?.maxSuggestions,
            language: context?.repository?.language,
            filePath: fileContext?.file?.filename,
            languageResultPrompt:
                context?.codeReviewConfig?.languageResultPrompt,
            reviewOptions: context?.codeReviewConfig?.reviewOptions,
            fileContent: fileContext?.file?.fileContent,
            limitationType:
                context?.codeReviewConfig?.suggestionControl?.limitationType,
            severityLevelFilter:
                context?.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter,
            groupingMode:
                context?.codeReviewConfig?.suggestionControl?.groupingMode,
            organizationAndTeamData: context?.organizationAndTeamData,
        };

        return baseContext;
    }

    private async createAnalysisChainWithFallback(
        provider: LLMModelProvider,
        context: any,
        reviewMode: ReviewModeResponse,
    ) {
        const fallbackProvider = this.getFallbackProvider(provider, reviewMode);

        try {
            const mainChain = await this.createAnalysisProviderChain(
                provider,
                reviewMode,
            );
            const fallbackChain = await this.createAnalysisProviderChain(
                fallbackProvider,
                reviewMode,
            );

            // Use withFallbacks to properly configure the fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'analyzeCodeWithAI',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                        reviewMode: reviewMode,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                },
            });
            throw error;
        }
    }

    private async createAnalysisProviderChain(
        provider: LLMModelProvider,
        reviewModeResponse: ReviewModeResponse,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : provider === LLMModelProvider.GEMINI_2_5_PRO_PREVIEW
                      ? getChatGemini({
                            model: LLMModelProvider.GEMINI_2_5_PRO_PREVIEW,
                            temperature: 0,
                            callbacks: [this.tokenTracker],
                        })
                      : getChatGPT({
                            model: getLLMModelProviderWithFallback(
                                LLMModelProvider.CHATGPT_4_ALL,
                            ),
                            temperature: 0,
                            callbacks: [this.tokenTracker],
                        });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            if (provider === LLMModelProvider.DEEPSEEK_V3) {
                const lightModeChain = RunnableSequence.from([
                    async (input: any) => {
                        return [
                            {
                                role: 'user',
                                content: [
                                    {
                                        type: 'text',
                                        text: prompt_codereview_user_deepseek(
                                            input,
                                        ),
                                    },
                                ],
                            },
                        ];
                    },
                    llm,
                    new StringOutputParser(),
                ]);

                return lightModeChain;
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: prompt_codereview_system_gemini(
                                        input,
                                    ),
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
                message: 'Error creating analysis code chain',
                error,
                context: LLMAnalysisService.name,
                metadata: { provider },
            });
            throw error;
        }
    }
    //#endregion

    //#region Light Mode Functions
    private getInitialProvider(
        context: AnalysisContext,
        reviewModeResponse: ReviewModeResponse,
    ): LLMModelProvider {
        if (
            reviewModeResponse === ReviewModeResponse.LIGHT_MODE &&
            context?.codeReviewConfig?.reviewModeConfig ===
                ReviewModeConfig.LIGHT_MODE_FULL
        ) {
            return LLMModelProvider.DEEPSEEK_V3;
        }
        return LLMModelProvider.GEMINI_2_5_PRO_PREVIEW;
    }

    private getFallbackProvider(
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
    ): LLMModelProvider {
        if (reviewMode === ReviewModeResponse.LIGHT_MODE) {
            return LLMModelProvider.GEMINI_2_5_PRO_PREVIEW;
        }

        const fallbackProvider =
            provider === LLMModelProvider.GEMINI_2_5_PRO_PREVIEW
                ? LLMModelProvider.DEEPSEEK_V3
                : LLMModelProvider.GEMINI_2_5_PRO_PREVIEW;

        return fallbackProvider;
    }
    //#endregion

    //#region Generate Code Suggestions
    private async createSuggestionsChainWithFallback(
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.GEMINI_2_5_PRO_PREVIEW
                : LLMModelProvider.CHATGPT_4_ALL;
        try {
            // Main chain
            const mainChain = await this.createAnalysisChainWithFallback(
                provider,
                {},
                reviewMode,
            );

            const fallbackChain = await this.createAnalysisChainWithFallback(
                fallbackProvider,
                {},
                reviewMode,
            );

            // Combine with fallback
            return RunnableSequence.from([mainChain, fallbackChain]);
        } catch (error) {
            this.logger.error({
                message: 'Error creating suggestions chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                },
            });
            throw error;
        }
    }

    async generateCodeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        sessionId: string,
        question: string,
        parameters: any,
        reviewMode: ReviewModeResponse = ReviewModeResponse.LIGHT_MODE,
    ) {
        const provider =
            parameters.llmProvider || LLMModelProvider.GEMINI_2_5_PRO_PREVIEW;

        // Reset token tracking for new suggestions
        this.tokenTracker.reset();

        try {
            const chain = await this.createSuggestionsChainWithFallback(
                provider,
                reviewMode,
            );
            const result = await chain.invoke({ question });

            // Log token usage
            const tokenUsages = this.tokenTracker.getTokenUsages();
            await this.logTokenUsage({
                tokenUsages,
                organizationAndTeamData,
                sessionId,
                parameters,
            });
            return result;
        } catch (error) {
            this.logger.error({
                message: `Error generating code suggestions`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    sessionId,
                    parameters,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Severity Analysis
    public async createSeverityAnalysisChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: any[],
        selectedCategories: object,
    ) {
        try {
            const model =
                provider === LLMModelProvider.CHATGPT_4_ALL
                    ? getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : getChatVertexAI({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      });

            const chain = RunnableSequence.from([
                async () => {
                    const systemPrompt = prompt_severity_analysis_system();
                    const humanPrompt = prompt_severity_analysis_user(
                        codeSuggestions,
                        selectedCategories,
                    );

                    return [
                        new SystemMessage(systemPrompt),
                        new HumanMessage(humanPrompt),
                    ];
                },
                model,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating severity analysis chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Filter Suggestions Safe Guard
    async filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
    ): Promise<ISafeguardResponse> {
        try {
            suggestions?.forEach((suggestion) => {
                if (
                    suggestion &&
                    Object.prototype.hasOwnProperty.call(
                        suggestion,
                        'suggestionEmbedded',
                    )
                ) {
                    delete suggestion?.suggestionEmbedded;
                }
            });

            const provider = LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET;
            const baseContext = {
                organizationAndTeamData,
                file: {
                    ...file,
                    fileContent: file.fileContent,
                },
                codeDiff,
                suggestions,
                languageResultPrompt,
            };

            // Create chain with fallback
            const chain = await this.createSafeGuardChainWithFallback(
                organizationAndTeamData,
                prNumber,
                provider,
                reviewMode,
                baseContext,
            );

            // Execute analysis
            const response = await chain.invoke(baseContext);

            const tokenUsages = this.tokenTracker.getTokenUsages();

            const filteredSuggestions =
                await this.extractSuggestionsFromCodeReviewSafeguard(
                    organizationAndTeamData,
                    prNumber,
                    response,
                );

            // Filter and update suggestions
            const suggestionsToUpdate =
                filteredSuggestions?.codeSuggestions?.filter(
                    (s) => s.action === 'update',
                );
            const suggestionsToDiscard = new Set(
                filteredSuggestions?.codeSuggestions
                    ?.filter((s) => s.action === 'discard')
                    .map((s) => s.id),
            );

            this.logTokenUsage({
                tokenUsages,
                pullRequestId: prNumber,
                fileContext: file?.filename,
                provider,
                organizationAndTeamData,
            });

            const filteredAndMappedSuggestions = suggestions
                ?.filter(
                    (suggestion) => !suggestionsToDiscard.has(suggestion.id),
                )
                ?.map((suggestion) => {
                    const updatedSuggestion = suggestionsToUpdate?.find(
                        (s) => s.id === suggestion.id,
                    );

                    if (!updatedSuggestion) {
                        return suggestion;
                    }

                    return {
                        ...suggestion,
                        suggestionContent: updatedSuggestion?.suggestionContent,
                        existingCode: updatedSuggestion?.existingCode,
                        improvedCode: updatedSuggestion?.improvedCode,
                        oneSentenceSummary:
                            updatedSuggestion?.oneSentenceSummary,
                        relevantLinesStart:
                            updatedSuggestion?.relevantLinesStart,
                        relevantLinesEnd: updatedSuggestion?.relevantLinesEnd,
                    };
                });

            return {
                suggestions: filteredAndMappedSuggestions,
                codeReviewModelUsed: {
                    safeguard: provider,
                },
            };
        } catch (error) {
            this.logger.error({
                message: `Error during suggestions safe guard analysis for PR#${prNumber}`,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    file: file?.filename,
                },
                error,
            });
            return { suggestions };
        }
    }

    private async createSafeGuardChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET
                : LLMModelProvider.CHATGPT_4_ALL;
        try {
            const mainChain = await this.createSafeGuardProviderChain(
                organizationAndTeamData,
                prNumber,
                provider,
                reviewMode,
                context,
            );
            const fallbackChain = await this.createSafeGuardProviderChain(
                organizationAndTeamData,
                prNumber,
                fallbackProvider,
                reviewMode,
                context,
            );

            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'filterSuggestionsSafeGuard',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                        reviewMode: reviewMode,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating safe guard chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData,
                    prNumber,
                },
            });
            throw error;
        }
    }

    private async createSafeGuardProviderChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        reviewMode: ReviewModeResponse,
        context?: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET
                    ? getChatVertexAI({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      });

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const systemPrompt = prompt_codeReviewSafeguard_system();
                    const humanPrompt = prompt_codeReviewSafeguard_user(
                        input.languageResultPrompt,
                    );

                    return [
                        {
                            role: 'user',
                            content: [
                                // Required for pipeline steps that use file or codeDiff
                                this.preparePrefixChainForCache(
                                    {
                                        fileContent: input.file.fileContent,
                                        patchWithLinesStr: input.codeDiff,
                                        language: input.file.language,
                                        filePath: input.file.filename,
                                    },
                                    reviewMode,
                                ),
                                {
                                    type: 'text',
                                    text: `<suggestionsContext>${JSON.stringify(input?.suggestions, null, 2) || 'No suggestions provided'}</suggestionsContext>`,
                                },
                                {
                                    type: 'text',
                                    text: systemPrompt,
                                },
                                {
                                    type: 'text',
                                    text: humanPrompt,
                                },
                                {
                                    type: 'text',
                                    text: 'Start analysis',
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
                message: `Error creating safe guard provider chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: { organizationAndTeamData, prNumber, provider },
            });
            throw error;
        }
    }

    private async extractSuggestionsFromText(
        text: string,
    ): Promise<CodeSuggestion[]> {
        try {
            const regex = /\{[\s\S]*"codeSuggestions"[\s\S]*\}/;
            const match = text.match(regex);

            if (!match) {
                throw new Error('No JSON with codeSuggestions found');
            }

            return JSON.parse(match[0]);
        } catch (error) {
            throw new Error(`Failed to extract suggestions: ${error.message}`);
        }
    }

    async extractSuggestionsFromCodeReviewSafeguard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        safeGuardResponse: any,
    ) {
        try {
            try {
                return await this.extractSuggestionsFromText(safeGuardResponse);
            } catch (error) {
                this.logger.warn({
                    message: `Failed to extract suggestions using code for PR#${prNumber}, falling back to LLM`,
                    context: LLMAnalysisService.name,
                    error,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                    },
                });

                // Fallback for LLM
                const provider = LLMModelProvider.CHATGPT_4_ALL_MINI;
                const baseContext = { safeGuardResponse };

                const chain =
                    await this.createExtractSuggestionsChainWithFallback(
                        organizationAndTeamData,
                        prNumber,
                        provider,
                        baseContext,
                    );

                return await chain.invoke(baseContext);
            }
        } catch (error) {
            this.logger.error({
                message: `Error extracting suggestions from safe guard response for PR#${prNumber}`,
                context: LLMAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                },
            });
            throw error;
        }
    }

    private async createExtractSuggestionsChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            const mainChain = await this.createExtractSuggestionsProviderChain(
                organizationAndTeamData,
                prNumber,
                provider,
                context,
            );
            const fallbackProvider =
                provider === LLMModelProvider.CHATGPT_4_ALL_MINI
                    ? LLMModelProvider.CHATGPT_4_ALL
                    : LLMModelProvider.CHATGPT_4_ALL_MINI;
            const fallbackChain =
                await this.createExtractSuggestionsProviderChain(
                    organizationAndTeamData,
                    prNumber,
                    fallbackProvider,
                    context,
                );

            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'extractSuggestionsFromCodeReviewSafeguard',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: `Error creating chain with fallback for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            throw error;
        }
    }

    private async createExtractSuggestionsProviderChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm = getChatGPT({
                model:
                    provider === LLMModelProvider.CHATGPT_4_ALL_MINI
                        ? getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL_MINI,
                          )
                        : getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                temperature: 0,
                callbacks: [this.tokenTracker],
            }).bind({
                response_format: { type: 'json_object' },
            });

            const parser = StructuredOutputParser.fromZodSchema(
                z.object({
                    codeSuggestions: z.array(
                        z
                            .object({
                                id: z.string(),
                                suggestionContent: z.string(),
                                existingCode: z.string(),
                                improvedCode: z.string(),
                                oneSentenceSummary: z.string(),
                                relevantLinesStart: z.string(),
                                relevantLinesEnd: z.string(),
                                label: z.string().optional(),
                                action: z.string(),
                                reason: z.string().optional(),
                            })
                            .refine(
                                (data) =>
                                    data.suggestionContent &&
                                    data.existingCode &&
                                    data.oneSentenceSummary &&
                                    data.relevantLinesStart &&
                                    data.relevantLinesEnd &&
                                    data.action,
                                {
                                    message: 'All fields are required',
                                },
                            ),
                    ),
                }),
            );

            const formatInstructions = parser.getFormatInstructions();

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const prompt = `${input.safeGuardResponse}\n\n${formatInstructions}`;
                    return [new HumanMessage({ content: prompt })];
                },
                llm,
                new StringOutputParser(),
                parser.parse.bind(parser),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: `Error creating extract suggestions provider chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Validate Implemented Suggestions
    async validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codePatch: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const baseContext = {
            organizationAndTeamData,
            prNumber,
            codePatch,
            codeSuggestions,
        };

        const chain =
            await this.createValidateImplementedSuggestionsChainWithFallback(
                organizationAndTeamData,
                prNumber,
                provider,
                baseContext,
            );

        try {
            const result = await chain.invoke(baseContext);

            const suggestionsWithImplementedStatus =
                this.llmResponseProcessor.processResponse(
                    organizationAndTeamData,
                    prNumber,
                    result,
                );

            const implementedSuggestions =
                suggestionsWithImplementedStatus?.codeSuggestions || [];

            return implementedSuggestions;
        } catch (error) {
            this.logger.error({
                message:
                    'Error executing validate implemented suggestions chain:',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
        }

        return codeSuggestions;
    }

    private async createValidateImplementedSuggestionsChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.DEEPSEEK_V3
                : LLMModelProvider.CHATGPT_4_ALL;

        try {
            // Chain principal
            const mainChain =
                await this.createValidateImplementedSuggestionsChain(
                    organizationAndTeamData,
                    prNumber,
                    provider,
                    context,
                );

            // Chain de fallback
            const fallbackChain =
                await this.createValidateImplementedSuggestionsChain(
                    organizationAndTeamData,
                    prNumber,
                    fallbackProvider,
                    context,
                );

            // Configurar chain com fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'validateImplementedSuggestions',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating validate implemented suggestions chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: prNumber,
                },
            });
            throw error;
        }
    }

    private async createValidateImplementedSuggestionsChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                          maxTokens: 8000,
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                      });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const humanPrompt = prompt_validateImplementedSuggestions({
                        codePatch: input.codePatch,
                        codeSuggestions: input.codeSuggestions,
                    });

                    return [
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
                message: `Error creating validate implemented suggestions chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: prNumber,
                    provider,
                },
            });
        }
    }

    //#endregion

    //#region Select Review Mode
    async selectReviewMode(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        file: FileChange,
        codeDiff: string,
    ): Promise<ReviewModeResponse> {
        const baseContext = {
            organizationAndTeamData,
            prNumber,
            file,
            codeDiff,
        };

        const chain = await this.createSelectReviewModeChainWithFallback(
            organizationAndTeamData,
            prNumber,
            provider,
            baseContext,
        );

        try {
            const result = await chain.invoke(baseContext);

            const reviewMode =
                this.llmResponseProcessor.processReviewModeResponse(
                    organizationAndTeamData,
                    prNumber,
                    result,
                );

            return reviewMode?.reviewMode || ReviewModeResponse.LIGHT_MODE;
        } catch (error) {
            this.logger.error({
                message: 'Error executing select review mode chain:',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
            return ReviewModeResponse.LIGHT_MODE;
        }
    }

    private async createSelectReviewModeChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.CHATGPT_4_ALL
                ? LLMModelProvider.DEEPSEEK_V3
                : LLMModelProvider.CHATGPT_4_ALL;

        try {
            // Main chain
            const mainChain = await this.createSelectReviewModeChain(
                organizationAndTeamData,
                prNumber,
                provider,
                context,
            );

            // Fallback chain
            const fallbackChain = await this.createSelectReviewModeChain(
                organizationAndTeamData,
                prNumber,
                fallbackProvider,
                context,
            );

            // Configure chain with fallback
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'selectReviewMode',
                    metadata: {
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message:
                    'Error creating select review mode chain with fallback',
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                    organizationAndTeamData,
                    prNumber,
                },
            });
            throw error;
        }
    }

    private async createSelectReviewModeChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        context: any,
    ) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                          maxTokens: 8000,
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                      });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    const humanPrompt = prompt_selectorLightOrHeavyMode_system({
                        file: input.file,
                        codeDiff: input.codeDiff,
                    });

                    return [
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
                message: `Error creating select review mode chain for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    provider,
                },
            });
        }
    }

    //#endregion
}
