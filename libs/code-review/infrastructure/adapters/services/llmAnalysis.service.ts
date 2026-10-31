import { LLM } from '@libs/llm/llm';
import { LLM_ERROR_TAG } from '@libs/llm/log-tags';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { estimateTokens } from './utils/token-estimator';
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

    //#region Validate Implemented Suggestions
    async validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        byokConfig: NormalizedModel | undefined,
        codePatch: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<Partial<CodeSuggestion>[]> {
        const runName = 'validateImplementedSuggestions';

        try {
            // Migrated off the legacy LangChain PromptRunner onto the AI SDK
            // path (REQ-NOLC-01), single span (Q4). Routed through the org's own
            // BYOK slot (resolveTaskSlot at the caller) — falls back to the
            // managed default when the org has none configured for this task.
            // The prompt returns `{ id, relevantFile, implementationStatus }` per
            // suggestion; the structured result is re-serialized and fed through
            // LLMResponseProcessor exactly as the STRING/JSON path did, preserving
            // the downstream mapping.
            const batches = this.splitValidationBatches(
                byokConfig,
                codePatch,
                codeSuggestions,
            );
            // No patch section matches a suggestion: nothing to verify against.
            if (!batches.length) return codeSuggestions;

            // One call per batch: a diff that exceeds the BYOK slot's context
            // window is rejected by the provider, so each batch carries only the
            // patches (and the suggestions on them) that fit.
            const results: Array<{
                codeSuggestions: z.infer<
                    typeof validateImplementedSchema
                >['codeSuggestions'];
            }> = [];
            for (const batch of batches) {
                // A failing batch must not discard the ones that succeeded or
                // stop the remaining ones: log it and keep going.
                try {
                    const batchResult = await LLM.run({
                        schema: validateImplementedSchema,
                        user: prompt_validateImplementedSuggestions(batch),
                        runName,
                        organizationId: organizationAndTeamData?.organizationId,
                        byokConfig,
                        attrs: {
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            prNumber,
                        },
                    });
                    if (batchResult) {
                        results.push(batchResult);
                    }
                } catch (error) {
                    this.logger.error({
                        message: `${LLM_ERROR_TAG} Error validating a batch of implemented suggestions:`,
                        error,
                        context: LLMAnalysisService.name,
                        metadata: {
                            organizationAndTeamData,
                            prNumber,
                            usingByok: !!byokConfig,
                        },
                    });
                }
            }

            const result = results.length
                ? {
                      codeSuggestions: results.flatMap(
                          (r) => r.codeSuggestions,
                      ),
                  }
                : undefined;

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

    /**
     * Splits the verification payload so every request fits the slot's context
     * window. Returns a single batch (the payload untouched) when there is no
     * BYOK slot or the payload already fits. Otherwise the patch is split per
     * file, patches with no suggestion on them are dropped, and the rest are
     * grouped into batches together with the suggestions that point at them. A
     * single patch larger than the budget is cut to fit.
     */
    private splitValidationBatches(
        byokConfig: NormalizedModel | undefined,
        codePatch: string,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Array<{
        codePatch: string;
        codeSuggestions: Partial<CodeSuggestion>[];
    }> {
        const whole = { codePatch, codeSuggestions };
        if (!byokConfig) return [whole];

        const budget = Math.floor(
            resolveContextWindow({
                byokMaxInputTokens: byokConfig.maxInputTokens,
                modelName: byokConfig.model,
            }) * 0.9,
        );
        // The prompt's fixed part (instructions + suggestions) depends on the
        // suggestions a request carries, so it is measured per batch.
        const fixedFor = (batchSuggestions: Partial<CodeSuggestion>[]) =>
            estimateTokens(
                prompt_validateImplementedSuggestions({
                    codePatch: '',
                    codeSuggestions: batchSuggestions,
                }),
            );
        if (
            fixedFor(codeSuggestions) +
                estimateTokens(JSON.stringify(codePatch)) <=
            budget
        ) {
            return [whole];
        }

        const suggestionsByFile = new Map<string, Partial<CodeSuggestion>[]>();
        for (const suggestion of codeSuggestions) {
            const file = suggestion.relevantFile;
            if (!file) continue;
            const list = suggestionsByFile.get(file) ?? [];
            list.push(suggestion);
            suggestionsByFile.set(file, list);
        }

        const batches: Array<{
            codePatch: string;
            codeSuggestions: Partial<CodeSuggestion>[];
        }> = [];
        let sections: string[] = [];
        let suggestions: Partial<CodeSuggestion>[] = [];
        let used = 0;
        const flush = () => {
            if (sections.length) {
                batches.push({
                    codePatch: sections.join('\n\n'),
                    codeSuggestions: suggestions,
                });
            }
            sections = [];
            suggestions = [];
            used = 0;
        };

        // The caller joins patches as `File: <name>\n<patch>` blocks.
        for (const raw of codePatch.split(/\n\n(?=File: )/)) {
            const filename = raw.match(/^File: ([^\n]*)/)?.[1];
            const forFile = filename && suggestionsByFile.get(filename);
            if (!forFile) continue;

            // The prompt embeds the patch JSON-escaped, which costs more tokens.
            const cost = (text: string) => estimateTokens(JSON.stringify(text));
            // One file can carry more suggestions than a request holds: group
            // them so the fixed part leaves at least half the budget for the
            // patch, then give each group the section cut to what is left.
            const groups: Partial<CodeSuggestion>[][] = [];
            let group: Partial<CodeSuggestion>[] = [];
            for (const suggestion of forFile) {
                if (
                    group.length &&
                    fixedFor([...group, suggestion]) > budget / 2
                ) {
                    groups.push(group);
                    group = [];
                }
                group.push(suggestion);
            }
            if (group.length) groups.push(group);

            for (const [index, groupSuggestions] of groups.entries()) {
                // Each group carries its own copy of the section: keep them in
                // separate requests.
                if (index > 0) flush();
                let section = raw;
                // Room left for patch text next to this group's suggestions.
                const own = budget - fixedFor(groupSuggestions);
                // Suggestions that alone fill the slot cannot be verified.
                if (own <= 0) continue;
                let tokens = cost(section);
                // A single patch over the budget is cut, measuring as it goes:
                // no fixed chars-per-token ratio holds for dense diffs.
                while (tokens > own && section.length > 1) {
                    section = section.slice(
                        0,
                        Math.floor((section.length * own) / tokens) - 1,
                    );
                    tokens = cost(section);
                }
                if (
                    suggestions.length &&
                    fixedFor([...suggestions, ...groupSuggestions]) +
                        used +
                        tokens >
                        budget
                ) {
                    flush();
                }
                sections.push(section);
                suggestions.push(...groupSuggestions);
                used += tokens;
            }
        }
        flush();

        // Nothing matched a patch section: there is nothing to verify against,
        // and resending the oversized payload would only be rejected.
        return batches;
    }
}
