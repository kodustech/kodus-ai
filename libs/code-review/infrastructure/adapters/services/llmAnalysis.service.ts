import { type ContextPack } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { createLogger } from '@libs/core/log/logger';
import { LLMModelProvider } from '@libs/llm/model-providers';
import type { BYOKConfig } from '@libs/llm/byok-config';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';

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
import { ObservabilityService } from '@libs/core/log/observability.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { SafeguardPipelineService } from './safeguardPipeline.service';

export const LLM_ANALYSIS_SERVICE_TOKEN = Symbol.for('LLMAnalysisService');

/**
 * Structured-output schema for the code-review analyzers. Mirrors the shape the
 * `prompt_codereview_*` prompts already declare in their Output Format section,
 * so migrating from the STRING/JSON parser to a structured call does not force
 * the model to fabricate fields. Optional fields match the prompt's optional
 * output (id/severity/rankScore/oneSentenceSummary/lines/llmPrompt).
 */
export const codeReviewAnalysisSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            id: z.string().optional(),
            relevantFile: z.string(),
            language: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string().optional(),
            improvedCode: z.string(),
            oneSentenceSummary: z.string().optional(),
            relevantLinesStart: z.coerce.number().int().positive().optional(),
            relevantLinesEnd: z.coerce.number().int().positive().optional(),
            label: z.string(),
            severity: z.string().optional(),
            rankScore: z.number().optional(),
            llmPrompt: z.string().optional(),
        }),
    ),
});

/**
 * Severity analyzer output — the `prompt_severity_analysis_user` prompt returns
 * ONLY `{ id, severity }` per suggestion, so the schema is deliberately narrow.
 * The result is re-serialized and fed through `LLMResponseProcessor` unchanged,
 * preserving the exact downstream mapping.
 */
export const severityAnalysisSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            id: z.string(),
            severity: z.string(),
        }),
    ),
});

/**
 * Validate-implemented output — `prompt_validateImplementedSuggestions` returns
 * `{ id, relevantFile, implementationStatus }` per suggestion.
 */
export const validateImplementedSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            id: z.string(),
            relevantFile: z.string(),
            implementationStatus: z.string(),
        }),
    ),
});

@Injectable()
export class LLMAnalysisService implements IAIAnalysisService {
    private readonly logger = createLogger(LLMAnalysisService.name);
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(
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
        const runName = 'analyzeCodeWithAI';

        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );
        const byokConfigRef = context?.codeReviewConfig?.byokConfig;

        try {
            // Migrated off the kodus-common LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01). Single span via runStructuredReviewCall — the
            // outer runLLMInSpan wrapper is dropped (Q4). The BYOK org keeps its
            // own model. The structured result is re-serialized and fed through
            // LLMResponseProcessor exactly as the STRING/JSON path did, preserving
            // the downstream codeSuggestions mapping.
            const analysis = await runStructuredReviewCall({
                schema: codeReviewAnalysisSchema,
                system: prompt_codereview_system_gemini(baseContext),
                user: prompt_codereview_user_gemini(baseContext),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                observabilityService: this.observability,
                byokConfig: byokConfigRef,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber,
                    file: { filePath: fileContext?.file?.filename },
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
                JSON.stringify(analysis),
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
        const runName = 'analyzeCodeWithAI_v2';

        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );

        try {
            // Migrated off the kodus-common LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01). Single span via runStructuredReviewCall — the
            // outer runLLMInSpan wrapper is dropped (Q4). The BYOK org keeps its
            // own model; the structured `codeSuggestions` map through unchanged.
            // The previous ZOD parser-correction provider (OPENAI_GPT_4O_MINI /
            // GPT_4O) is intentionally dropped — that was the LangChain parser
            // repair path (D-03/REQ-SEC-01). `setTemperature(0)` /
            // `setMaxReasoningTokens(3000)` are not threaded by
            // runStructuredReviewCall (per the phase's tracer decision).
            const analysis = await runStructuredReviewCall({
                schema: codeReviewAnalysisSchema,
                system: prompt_codereview_system_gemini_v2(baseContext),
                user: prompt_codereview_user_gemini_v2(baseContext),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                observabilityService: this.observability,
                byokConfig,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber,
                    file: { filePath: fileContext?.file?.filename },
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
        const runName = 'generateCodeSuggestions';

        try {
            // Migrated off the kodus-common LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01), single span (Q4). This is a system-provider path
            // (no BYOK): per the phase's tracer decision the previous
            // GEMINI_2_5_PRO/OPENAI_GPT_4O pin is dropped in favour of the managed
            // review default; per-task model routing is deferred to Phase 4. The
            // structured result is re-serialized so the string return contract is
            // preserved for any legacy caller.
            const structured = await runStructuredReviewCall({
                schema: codeReviewAnalysisSchema,
                system: prompt_codereview_system_gemini({}),
                user: `${prompt_codereview_user_gemini({})}\n\n## Question\n${question ?? ''}`,
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                observabilityService: this.observability,
                byokConfig: undefined,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    sessionId,
                },
            });

            const result = structured ? JSON.stringify(structured) : null;

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
        const runName = 'severityAnalysis';

        try {
            // Migrated off the kodus-common LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01), single span (Q4). BYOK org keeps its own model.
            // The severity prompt returns `{ id, severity }` per suggestion; the
            // structured result is re-serialized and fed through LLMResponseProcessor
            // exactly as the STRING/JSON path did, preserving the downstream mapping.
            const result = await runStructuredReviewCall({
                schema: severityAnalysisSchema,
                system: '',
                user: prompt_severity_analysis_user(codeSuggestions),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                observabilityService: this.observability,
                byokConfig,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber,
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
                    JSON.stringify(result),
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
        const runName = 'validateImplementedSuggestions';

        const payload = { codePatch, codeSuggestions };

        try {
            // Migrated off the kodus-common LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01), single span (Q4). System-provider path (no BYOK):
            // per the phase's tracer decision the previous provider/fallback pin is
            // dropped in favour of the managed review default; per-task model routing
            // is deferred to Phase 4. The prompt returns
            // `{ id, relevantFile, implementationStatus }` per suggestion; the
            // structured result is re-serialized and fed through LLMResponseProcessor
            // exactly as the STRING/JSON path did, preserving the downstream mapping.
            const result = await runStructuredReviewCall({
                schema: validateImplementedSchema,
                system: '',
                user: prompt_validateImplementedSuggestions(payload),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                observabilityService: this.observability,
                byokConfig: undefined,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber,
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
                    JSON.stringify(result),
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
