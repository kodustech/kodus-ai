import { LLM } from '@libs/llm/llm';
import { LLM_ERROR_TAG } from '@libs/llm/log-tags';
import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { LLMResponseProcessor } from '@libs/ai-engine/infrastructure/adapters/services/llmResponseProcessor.transform';
import { IAIAnalysisService } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';
import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { prompt_validateImplementedSuggestions } from '@libs/common/utils/prompts';
import { prompt_severity_analysis_user } from '@libs/common/utils/prompts/severityAnalysis';
import {
    CodeSuggestion,
    DocumentationContextItem,
    ISafeguardResponse,
    ReviewModeResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { SafeguardPipelineService } from './safeguardPipeline.service';

export const LLM_ANALYSIS_SERVICE_TOKEN = Symbol.for('LLMAnalysisService');

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

    //#region Severity Analysis
    async severityAnalysisAssignment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        codeSuggestions: CodeSuggestion[],
        byokConfig: NormalizedModel,
    ): Promise<Partial<CodeSuggestion>[]> {
        const runName = 'severityAnalysis';

        try {
            // Migrated off the legacy LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01), single span (Q4). BYOK org keeps its own model.
            // The severity prompt returns `{ id, severity }` per suggestion; the
            // structured result is re-serialized and fed through LLMResponseProcessor
            // exactly as the STRING/JSON path did, preserving the downstream mapping.
            const result = await LLM.run({
                schema: severityAnalysisSchema,
                system: '',
                user: prompt_severity_analysis_user(codeSuggestions),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
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
                message: `${LLM_ERROR_TAG} Error executing validate implemented suggestions chain:`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
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
        byokConfig: NormalizedModel,
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
                message: `${LLM_ERROR_TAG} Error during suggestions safe guard analysis for PR#${prNumber}`,
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
        byokConfig: NormalizedModel | undefined,
        codePatch: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const runName = 'validateImplementedSuggestions';

        const payload = { codePatch, codeSuggestions };

        try {
            // Migrated off the legacy LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01), single span (Q4). Routed through the org's own
            // BYOK slot (resolveTaskSlot at the caller) — falls back to the
            // managed default when the org has none configured for this task.
            // The prompt returns `{ id, relevantFile, implementationStatus }` per
            // suggestion; the structured result is re-serialized and fed through
            // LLMResponseProcessor exactly as the STRING/JSON path did, preserving
            // the downstream mapping.
            const result = await LLM.run({
                schema: validateImplementedSchema,
                system: '',
                user: prompt_validateImplementedSuggestions(payload),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                byokConfig,
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
                        usingByok: !!byokConfig,
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
                message: `${LLM_ERROR_TAG} Error executing validate implemented suggestions chain:`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    usingByok: !!byokConfig,
                },
            });
        }
        return codeSuggestions;
    }
    //#endregion
}
