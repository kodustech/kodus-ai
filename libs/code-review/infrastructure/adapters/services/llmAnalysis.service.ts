import { createLogger, type ContextPack } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
    getAugmentationsFromPack,
    getOverridesFromPack,
} from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context.utils';
import { ContextAugmentationsMap } from '@libs/ai-engine/infrastructure/adapters/services/context/interfaces/code-review-context-pack.interface';
import { LLMResponseProcessor } from '@libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform';
import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';
import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { prompt_validateImplementedSuggestions } from '@libs/common/utils/langchainCommon/prompts';
import {
    prompt_codereview_system_gemini,
    prompt_codereview_system_gemini_v2,
    prompt_codereview_user_gemini,
    prompt_codereview_user_gemini_v2,
} from '@libs/common/utils/langchainCommon/prompts/configuration/codeReview';
import { prompt_severity_analysis_user } from '@libs/common/utils/langchainCommon/prompts/severityAnalysis';
import {
    AIAnalysisResult,
    AnalysisContext,
    CodeSuggestion,
    DocumentationContextItem,
    FileChange,
    FileChangeContext,
    ISafeguardResponse,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { SafeguardPipelineService } from './safeguardPipeline.service';

export const LLM_ANALYSIS_SERVICE_TOKEN = Symbol.for('LLMAnalysisService');

@Injectable()
export class LLMAnalysisService implements IAIAnalysisService {
    private readonly logger = createLogger(LLMAnalysisService.name);
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observability: ObservabilityService,
        private readonly safeguardPipeline: SafeguardPipelineService,
    ) {
        this.llmResponseProcessor = new LLMResponseProcessor();
    }

    //#region Helper Functions
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
        const byokConfigRef = context?.codeReviewConfig?.byokConfig;
        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            file: { filePath: fileContext?.file?.filename },
        };

        try {
            const { result: analysis } = await this.observability.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                byokConfig: byokConfigRef,
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(ParserType.STRING)
                        .setLLMJsonMode(true)
                        .setPayload(baseContext)
                        .addPrompt({
                            prompt: prompt_codereview_system_gemini,
                            role: PromptRole.SYSTEM,
                        })
                        .addPrompt({
                            prompt: prompt_codereview_user_gemini,
                            role: PromptRole.USER,
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
            const { result: analysis } = await this.observability.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                byokConfig,
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
                                relevantLinesStart: z.coerce
                                    .number()
                                    .int()
                                    .positive()
                                    .optional(),
                                relevantLinesEnd: z.coerce
                                    .number()
                                    .int()
                                    .positive()
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
                            fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
                        })
                        .setLLMJsonMode(true)
                        .setPayload(baseContext)
                        .addPrompt({
                            prompt: prompt_codereview_system_gemini_v2,
                            role: PromptRole.SYSTEM,
                        })
                        .addPrompt({
                            prompt: prompt_codereview_user_gemini_v2,
                            role: PromptRole.USER,
                        })
                        .setTemperature(0)
                        .addCallbacks(callbacks)
                        .addMetadata({
                            hasRelevantContent: baseContext?.hasRelevantContent,
                            organizationId:
                                baseContext?.organizationAndTeamData
                                    ?.organizationId,
                            teamId: baseContext?.organizationAndTeamData
                                ?.teamId,
                            pullRequestId: baseContext?.pullRequest?.number,
                            provider:
                                byokConfig?.main?.provider || defaultProvider,
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
            crossFileSnippets: context?.crossFileSnippets,
            memories: context?.codeReviewConfig?.kodyMemoryRules || [],
            documentationContext: context?.documentationContext || [],
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
        reviewMode: ReviewModeResponse = ReviewModeResponse.HEAVY_MODE,
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
            const { result } = await this.observability.runLLMInSpan({
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
                        })
                        .addPrompt({
                            prompt: () => prompt_codereview_user_gemini({}),
                            role: PromptRole.USER,
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
            const { result } = await this.observability.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                byokConfig,
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
        crossFileSnippets?: CrossFileContextSnippet[],
        remoteCommands?: RemoteCommands,
        memories?: Array<Partial<IKodyRule>>,
        externalReferences?: unknown[],
        externalReferenceErrors?: unknown[] | string,
        getFreshCloneParams?: () => Promise<CreateSandboxParams>,
        documentationContext?: DocumentationContextItem[],
    ): Promise<ISafeguardResponse> {
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

        try {
            return await this.safeguardPipeline.execute({
                organizationAndTeamData,
                prNumber,
                file,
                relevantContent,
                codeDiff,
                suggestions,
                languageResultPrompt,
                reviewMode,
                byokConfig,
                crossFileSnippets,
                remoteCommands,
                memories,
                externalReferences,
                externalReferenceErrors,
                getFreshCloneParams,
                documentationContext,
            });
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
            const { result } = await this.observability.runLLMInSpan({
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
        return ReviewModeResponse.HEAVY_MODE;
    }
    //#endregion
}
