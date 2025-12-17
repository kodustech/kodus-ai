import {
    AIAnalysisResult,
    AnalysisContext,
    CodeSuggestion,
    FileChange,
    FileChangeContext,
    ISafeguardResponse,
    ReviewModeResponse,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { Injectable } from '@nestjs/common';
import { IAIAnalysisService } from '../../../../domain/codeBase/contracts/AIAnalysisService.contract';
import { PinoLoggerService } from '../logger/pino.service';

import { BYOKPromptRunnerService } from '@/shared/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { prompt_codeReviewSafeguard_system } from '@/shared/utils/langchainCommon/prompts';
import {
    prompt_codereview_system_gemini,
    prompt_codereview_system_gemini_v2,
    prompt_codereview_user_deepseek,
    prompt_codereview_user_gemini,
    prompt_codereview_user_gemini_v2,
} from '@/shared/utils/langchainCommon/prompts/configuration/codeReview';
import { prompt_selectorLightOrHeavyMode_system } from '@/shared/utils/langchainCommon/prompts/seletorLightOrHeavyMode';
import { prompt_severity_analysis_user } from '@/shared/utils/langchainCommon/prompts/severityAnalysis';
import { prompt_validateImplementedSuggestions } from '@/shared/utils/langchainCommon/prompts/validateImplementedSuggestions';
import type { ContextPack } from '@context-os-core/interfaces';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
    PromptScope,
} from '@kodus/kodus-common/llm';
import { z } from 'zod';
import type { ContextAugmentationsMap } from '../context/code-review-context-pack.service';
import {
    getAugmentationsFromPack,
    getOverridesFromPack,
} from '../context/code-review-context.utils';
import { ObservabilityService } from '../logger/observability.service';
import { LLMResponseProcessor } from './utils/transforms/llmResponseProcessor.transform';

export const LLM_ANALYSIS_SERVICE_TOKEN = Symbol('LLMAnalysisService');

@Injectable()
export class LLMAnalysisService implements IAIAnalysisService {
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(
        private readonly logger: PinoLoggerService,
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
    ) {
        this.llmResponseProcessor = new LLMResponseProcessor(logger);
    }

    //#region Helper Functions
    // Creates the prefix for the prompt cache (every prompt that uses file or codeDiff must start with this)
    private preparePrefixChainForCache(context: {
        patchWithLinesStr: string;
        fileContent: string;
        relevantContent: string;
        language: string;
        filePath: string;
        suggestions?: CodeSuggestion[];
        reviewMode: ReviewModeResponse;
    }) {
        if (!context?.patchWithLinesStr) {
            throw new Error('Required context parameters are missing');
        }

        const { reviewMode } = context;

        if (reviewMode === ReviewModeResponse.LIGHT_MODE) {
            return `
## Context

<codeDiff>
    ${context.patchWithLinesStr}
</codeDiff>

<filePath>
    ${context.filePath}
</filePath>

<suggestionsContext>
    ${JSON.stringify(context?.suggestions, null, 2) || 'No suggestions provided'}
</suggestionsContext>`;
        }

        return `
## Context

<fileContent>
    ${context.relevantContent || context.fileContent}
</fileContent>

<codeDiff>
    ${context.patchWithLinesStr}
</codeDiff>

<filePath>
    ${context.filePath}
</filePath>

<suggestionsContext>
${JSON.stringify(context?.suggestions, null, 2) || 'No suggestions provided'}
</suggestionsContext>`;
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
        const provider = LLMModelProvider.GEMINI_2_5_PRO;
        const fallbackProvider = LLMModelProvider.NOVITA_DEEPSEEK_V3;
        const runName = 'analyzeCodeWithAI';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            context?.codeReviewConfig?.byokConfig,
        );

        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );
        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            file: { filePath: fileContext?.file?.filename },
        };

        try {
            const { result: analysis } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    exec: async (callbacks) => {
                        return await promptRunner
                            .builder()
                            .setParser(ParserType.STRING)
                            .setLLMJsonMode(true)
                            .setPayload(baseContext)
                            .addPrompt({
                                prompt: prompt_codereview_system_gemini,
                                role: PromptRole.SYSTEM,
                                scope: PromptScope.MAIN,
                            })
                            .addPrompt({
                                prompt: prompt_codereview_user_gemini,
                                role: PromptRole.USER,
                                scope: PromptScope.MAIN,
                            })
                            .addPrompt({
                                prompt: prompt_codereview_user_deepseek,
                                role: PromptRole.USER,
                                scope: PromptScope.FALLBACK,
                            })
                            .setTemperature(0)
                            .addCallbacks(callbacks)
                            .addMetadata({
                                organizationId:
                                    baseContext?.organizationAndTeamData
                                        ?.organizationId,
                                teamId: baseContext?.organizationAndTeamData
                                    ?.teamId,
                                pullRequestId: baseContext?.pullRequest?.number,
                                provider,
                                fallbackProvider,
                                reviewMode: reviewModeResponse,
                                runName,
                            })
                            .setRunName(runName)
                            .execute();
                    },
                });

            if (!analysis) {
                const message = `No analysis result for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData:
                            baseContext?.organizationAndTeamData,
                        prNumber: baseContext?.pullRequest?.number,
                    },
                });
                throw new Error(message);
            }

            const analysisResult = this.llmResponseProcessor.processResponse(
                organizationAndTeamData,
                prNumber,
                analysis,
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

    async analyzeCodeWithAI_v2(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse,
        context: AnalysisContext,
        byokConfig: BYOKConfig,
    ): Promise<AIAnalysisResult> {
        const defaultProvider = LLMModelProvider.GEMINI_2_5_PRO;
        const defaultFallback = LLMModelProvider.NOVITA_DEEPSEEK_V3;
        const runName = 'analyzeCodeWithAI_v2';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            defaultProvider,
            defaultFallback,
            byokConfig,
        );

        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );
        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            file: { filePath: fileContext?.file?.filename },
        };

        try {
            const { result: analysis } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    exec: async (callbacks) => {
                        const schema = z.object({
                            codeSuggestions: z.array(
                                z.object({
                                    id: z.string().optional(),
                                    relevantFile: z.string(),
                                    language: z.string(),
                                    suggestionContent: z.string(),
                                    existingCode: z.string().optional(),
                                    improvedCode: z.string(),
                                    oneSentenceSummary: z.string().optional(),
                                    relevantLinesStart: z
                                        .number()
                                        .min(1)
                                        .optional(),
                                    relevantLinesEnd: z
                                        .number()
                                        .min(1)
                                        .optional(),
                                    label: z.string(),
                                    severity: z.string().optional(),
                                    rankScore: z.number().optional(),
                                    llmPrompt: z.string().optional(),
                                }),
                            ),
                        });

                        return await promptRunner
                            .builder()
                            .setParser(ParserType.ZOD, schema, {
                                provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                                fallbackProvider:
                                    LLMModelProvider.OPENAI_GPT_4O,
                            })
                            .setLLMJsonMode(true)
                            .setPayload(baseContext)
                            .addPrompt({
                                prompt: prompt_codereview_system_gemini_v2,
                                role: PromptRole.SYSTEM,
                                scope: PromptScope.MAIN,
                            })
                            .addPrompt({
                                prompt: prompt_codereview_user_gemini_v2,
                                role: PromptRole.USER,
                                scope: PromptScope.MAIN,
                            })
                            .addPrompt({
                                prompt: prompt_codereview_user_deepseek,
                                role: PromptRole.USER,
                                scope: PromptScope.FALLBACK,
                            })
                            .setTemperature(0)
                            .addCallbacks(callbacks)
                            .addMetadata({
                                hasRelevantContent:
                                    baseContext?.hasRelevantContent,
                                organizationId:
                                    baseContext?.organizationAndTeamData
                                        ?.organizationId,
                                teamId: baseContext?.organizationAndTeamData
                                    ?.teamId,
                                pullRequestId: baseContext?.pullRequest?.number,
                                provider:
                                    byokConfig?.main?.provider ||
                                    defaultProvider,
                                model: byokConfig?.main?.model,
                                fallbackProvider:
                                    byokConfig?.fallback?.provider ||
                                    defaultFallback,
                                fallbackModel: byokConfig?.fallback?.model,
                                reviewMode: reviewModeResponse,
                                runName,
                            })
                            .setRunName(runName)
                            .setMaxReasoningTokens(3000)
                            .execute();
                    },
                });

            if (!analysis) {
                const message = `No analysis result for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData:
                            baseContext?.organizationAndTeamData,
                        prNumber: baseContext?.pullRequest?.number,
                    },
                });
                throw new Error(message);
            }

            const analysisResult: AIAnalysisResult = {
                codeSuggestions: analysis.codeSuggestions,
                codeReviewModelUsed: {
                    generateSuggestions:
                        byokConfig?.main?.provider || defaultProvider,
                },
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
            relevantContent: fileContext?.relevantContent,
            hasRelevantContent: fileContext?.hasRelevantContent,
            prSummary: context?.pullRequest?.body,
            // v2-only prompt customization (categories and severity guidance)
            v2PromptOverrides:
                context?.activeOverrides ??
                getOverridesFromPack(context?.sharedContextPack) ??
                context?.codeReviewConfig?.v2PromptOverrides,
            // External prompt context (referenced files)
            externalPromptContext: context?.externalPromptContext,
            externalPromptLayers: context?.externalPromptLayers,
            contextAugmentations: {
                ...(getAugmentationsFromPack(context?.sharedContextPack) ?? {}),
                ...(context?.fileAugmentations ?? {}),
            } as ContextAugmentationsMap,
            contextPack: context?.sharedContextPack as ContextPack | undefined,
        };

        return baseContext;
    }
    //#endregion

    //#region Generate Code Suggestions
    async generateCodeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        sessionId: string,
        question: string,
        parameters: any,
        reviewMode: ReviewModeResponse = ReviewModeResponse.LIGHT_MODE,
    ) {
        const provider =
            parameters.llmProvider || LLMModelProvider.GEMINI_2_5_PRO;
        const fallbackProvider =
            provider === LLMModelProvider.OPENAI_GPT_4O
                ? LLMModelProvider.GEMINI_2_5_PRO
                : LLMModelProvider.OPENAI_GPT_4O;
        const runName = 'generateCodeSuggestions';

        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: 'system',
            organizationId: organizationAndTeamData?.organizationId,
            sessionId,
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await this.promptRunnerService
                        .builder()
                        .setProviders({
                            main: provider,
                            fallback: fallbackProvider,
                        })
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setPayload({ question })
                        .addPrompt({
                            prompt: () => prompt_codereview_system_gemini({}),
                            role: PromptRole.SYSTEM,
                            scope: PromptScope.MAIN,
                        })
                        .addPrompt({
                            prompt: () => prompt_codereview_user_gemini({}),
                            role: PromptRole.USER,
                            scope: PromptScope.MAIN,
                        })
                        .addPrompt({
                            prompt: () => prompt_codereview_user_deepseek({}),
                            role: PromptRole.USER,
                            scope: PromptScope.FALLBACK,
                        })
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            sessionId,
                            provider,
                            fallbackProvider,
                            reviewMode,
                            runName,
                        })
                        .addCallbacks(callbacks)
                        .setRunName(runName)
                        .setTemperature(0)
                        .execute();
                },
            });

            if (!result) {
                const message = `No code suggestions generated for session ${sessionId}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        sessionId,
                        parameters,
                    },
                });
                throw new Error(message);
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: `Error generating code suggestions`,
                error,
                context: LLMAnalysisService.name,
                metadata: { organizationAndTeamData, sessionId, parameters },
            });
            throw error;
        }
    }
    //#endregion

    //#region Severity Analysis
    async severityAnalysisAssignment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: CodeSuggestion[],
        byokConfig: BYOKConfig,
    ): Promise<Partial<CodeSuggestion>[]> {
        const fallbackProvider =
            provider === LLMModelProvider.OPENAI_GPT_4O
                ? LLMModelProvider.NOVITA_DEEPSEEK_V3_0324
                : LLMModelProvider.OPENAI_GPT_4O;
        const runName = 'severityAnalysis';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );

        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setPayload(codeSuggestions)
                        .addPrompt({
                            prompt: prompt_severity_analysis_user,
                            role: PromptRole.USER,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            pullRequestId: prNumber,
                            provider: byokConfig?.main?.provider || provider,
                            model: byokConfig?.main?.model,
                            fallbackProvider:
                                byokConfig?.fallback?.provider ||
                                fallbackProvider,
                            fallbackModel: byokConfig?.fallback?.model,
                            runName,
                        })
                        .setRunName(runName)
                        .setTemperature(0)
                        .execute();
                },
            });

            if (!result) {
                const message = `No severity analysis result for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                    },
                });
                throw new Error(message);
            }

            const suggestionsWithSeverityAnalysis =
                this.llmResponseProcessor.processResponse(
                    organizationAndTeamData,
                    prNumber,
                    result,
                );

            const suggestionsWithSeverity =
                suggestionsWithSeverityAnalysis?.codeSuggestions || [];

            return suggestionsWithSeverity;
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
    //#endregion

    //#region Filter Suggestions Safe Guard
    async filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        relevantContent: string,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
        reviewMode: ReviewModeResponse,
        byokConfig: BYOKConfig,
    ): Promise<ISafeguardResponse> {
        const runName = 'filterSuggestionsSafeGuard';

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

        const provider = LLMModelProvider.GEMINI_2_5_PRO;
        const fallbackProvider = LLMModelProvider.NOVITA_DEEPSEEK_V3;

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );

        const payload = {
            fileContent: file?.fileContent,
            relevantContent,
            patchWithLinesStr: codeDiff,
            language: file?.language,
            filePath: file?.filename,
            suggestions,
            languageResultPrompt,
            reviewMode,
        };

        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            file: { filePath: file?.filename },
        };

        try {
            const schema = z.object({
                codeSuggestions: z.array(
                    z.object({
                        id: z.string(),
                        suggestionContent: z.string(),
                        existingCode: z.string(),
                        improvedCode: z.string().nullable(),
                        oneSentenceSummary: z.string(),
                        relevantLinesStart: z.number().min(1),
                        relevantLinesEnd: z.number().min(1),
                        label: z.string().optional(),
                        action: z.string(),
                        reason: z.string().optional(),
                    }),
                ),
            });

            const { result: filteredSuggestions } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    exec: async (callbacks) => {
                        return await promptRunner
                            .builder()
                            .setParser(ParserType.ZOD, schema as any, {
                                provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                                fallbackProvider:
                                    LLMModelProvider.OPENAI_GPT_4O,
                            })
                            .setLLMJsonMode(true)
                            .setPayload(payload)
                            .addPrompt({
                                prompt: prompt_codeReviewSafeguard_system,
                                role: PromptRole.SYSTEM,
                            })
                            .addPrompt({
                                prompt: this.preparePrefixChainForCache(
                                    payload,
                                ),
                                role: PromptRole.USER,
                            })
                            .addMetadata({
                                organizationId:
                                    organizationAndTeamData?.organizationId,
                                teamId: organizationAndTeamData?.teamId,
                                pullRequestId: prNumber,
                                reviewMode,
                                model: byokConfig?.main?.model,
                                fallbackModel: byokConfig?.fallback?.model,
                                provider:
                                    byokConfig?.main?.provider || provider,
                                fallbackProvider:
                                    byokConfig?.fallback?.provider ||
                                    fallbackProvider,
                                runName,
                            })
                            .setTemperature(0)
                            .addCallbacks(callbacks)
                            .setRunName(runName)
                            .setMaxReasoningTokens(5000)
                            .execute();
                    },
                });

            if (!filteredSuggestions) {
                const message = `No response from safeguard for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        file: file?.filename,
                    },
                });
                throw new Error(message);
            }

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
                    safeguard: byokConfig?.main?.provider || provider,
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
    //#endregion

    //#region Validate Implemented Suggestions
    async validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codePatch: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const fallbackProvider =
            provider === LLMModelProvider.OPENAI_GPT_4O
                ? LLMModelProvider.NOVITA_DEEPSEEK_V3_0324
                : LLMModelProvider.OPENAI_GPT_4O;
        const runName = 'validateImplementedSuggestions';

        const payload = { codePatch, codeSuggestions };
        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: 'system',
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await this.promptRunnerService
                        .builder()
                        .setProviders({
                            main: provider,
                            fallback: fallbackProvider,
                        })
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setTemperature(0)
                        .setPayload(payload)
                        .addPrompt({
                            prompt: prompt_validateImplementedSuggestions,
                            role: PromptRole.USER,
                        })
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            pullRequestId: prNumber,
                            provider,
                            fallbackProvider,
                            runName,
                        })
                        .addCallbacks(callbacks)
                        .setRunName(runName)
                        .execute();
                },
            });

            if (!result) {
                const message = `No response from validate implemented suggestions for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        provider,
                    },
                });
                throw new Error(message);
            }

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
    //#endregion

    //#region Select Review Mode
    async selectReviewMode(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        file: FileChange,
        codeDiff: string,
    ): Promise<ReviewModeResponse> {
        const fallbackProvider =
            provider === LLMModelProvider.OPENAI_GPT_4O
                ? LLMModelProvider.NOVITA_DEEPSEEK_V3_0324
                : LLMModelProvider.OPENAI_GPT_4O;
        const runName = 'selectReviewMode';

        const payload = { file, codeDiff };
        const spanName = `${LLMAnalysisService.name}::${runName}`;
        const spanAttrs = {
            type: 'system',
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    return await this.promptRunnerService
                        .builder()
                        .setProviders({
                            main: provider,
                            fallback: fallbackProvider,
                        })
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setTemperature(0)
                        .setPayload(payload)
                        .addPrompt({
                            prompt: prompt_selectorLightOrHeavyMode_system,
                            role: PromptRole.SYSTEM,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            pullRequestId: prNumber,
                            provider,
                            fallbackProvider,
                            runName,
                        })
                        .setRunName(runName)
                        .execute();
                },
            });

            if (!result) {
                const message = `No response from select review mode for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: LLMAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        provider,
                    },
                });
                throw new Error(message);
            }

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
    //#endregion
}
