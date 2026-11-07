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
import {
    prompt_checkSuggestionImplementation,
    type ImplementationCheckSuggestion,
} from '@libs/common/utils/prompts';
import {
    normalizeImplementationStatus,
    type ImplementationUnmeasuredReason,
} from '@libs/platformData/domain/pullRequests/implementation-status';
import type { ImplementationCheckModelResult } from '@libs/code-review/domain/contracts/AIAnalysisService.contract';
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
 * Implementation-check output: one verdict per suggestion asked about. The
 * status stays a string on the wire so one unreadable item costs that item
 * only, not the whole call; the service normalizes it.
 */
export const implementationCheckSchema = z.object({
    verdicts: z.array(
        z.object({
            id: z.string(),
            // Optional, so a model that cannot answer one item can write null
            // (the wire schema turns null into absent): that costs the item,
            // not the whole file.
            implementationStatus: z.string().optional(),
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

    //#region Implementation check
    /**
     * Asks the model which of a file's suggestions the patch implemented.
     * Every suggestion comes back either with a verdict or as unmeasured with
     * the reason; a failure never reads as "not implemented".
     */
    async checkSuggestionImplementation({
        organizationAndTeamData,
        prNumber,
        byokConfig,
        file,
        suggestions,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        prNumber: number;
        byokConfig: NormalizedModel | undefined;
        file: { filename: string; patch: string };
        suggestions: ImplementationCheckSuggestion[];
    }): Promise<ImplementationCheckModelResult> {
        // Token usage and billing are keyed on this runName.
        const runName = 'validateImplementedSuggestions';
        const ids = suggestions.map((s) => s.id);
        const allUnmeasured = (
            reason: ImplementationUnmeasuredReason,
        ): ImplementationCheckModelResult => ({
            verdicts: [],
            unmeasured: ids.map((id) => ({ id, reason })),
        });

        let result: z.infer<typeof implementationCheckSchema>;
        try {
            result = await LLM.run({
                schema: implementationCheckSchema,
                user: prompt_checkSuggestionImplementation({
                    file,
                    suggestions,
                }),
                runName,
                organizationId: organizationAndTeamData?.organizationId,
                byokConfig,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber,
                },
            });
        } catch (error) {
            this.logger.error({
                message: `${LLM_ERROR_TAG} Implementation check failed for PR#${prNumber}`,
                error,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    file: file.filename,
                    suggestions: ids.length,
                    usingByok: !!byokConfig,
                },
            });
            return allUnmeasured('llm_error');
        }

        // LLM.run validates the answer against the schema, or throws.
        const asked = new Set(ids);
        const byId = new Map<string, string | undefined>();
        let foreign = 0;
        for (const answer of result.verdicts) {
            if (!asked.has(answer.id)) {
                foreign += 1;
                continue;
            }
            if (!byId.has(answer.id)) {
                byId.set(answer.id, answer.implementationStatus);
            }
        }

        const out: ImplementationCheckModelResult = {
            verdicts: [],
            unmeasured: [],
        };
        for (const id of ids) {
            if (!byId.has(id)) {
                out.unmeasured.push({ id, reason: 'omitted' });
                continue;
            }
            const status = normalizeImplementationStatus(byId.get(id));
            if (status) out.verdicts.push({ id, status });
            else out.unmeasured.push({ id, reason: 'invalid_output' });
        }

        if (out.unmeasured.length || foreign) {
            this.logger.warn({
                message: `Implementation check for PR#${prNumber} left suggestions undecided`,
                context: LLMAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    file: file.filename,
                    asked: ids.length,
                    decided: out.verdicts.length,
                    omitted: out.unmeasured.filter(
                        (u) => u.reason === 'omitted',
                    ).length,
                    invalid: out.unmeasured.filter(
                        (u) => u.reason === 'invalid_output',
                    ).length,
                    foreignIds: foreign,
                },
            });
        }

        return out;
    }
    //#endregion
}
