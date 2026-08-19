import { type ContextPack } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { LLM } from '@libs/llm/llm';
import { createLogger } from '@libs/core/log/logger';
import { LLMModelProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { z } from 'zod';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';

import {
    getAugmentationsFromPack,
    getOverridesFromPack,
} from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context.utils';
import type { ContextAugmentationsMap } from '@libs/ai-engine/infrastructure/adapters/services/context/interfaces/code-review-context-pack.interface';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { IKodyRulesAnalysisService } from '@libs/code-review/domain/contracts/KodyRulesAnalysisService.contract';
import { buildKodyRuleLink } from '@libs/code-review/utils/build-kody-rule-link';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import {
    KodyRulesClassifierSchema,
    kodyRulesClassifierSchema,
    kodyRulesGeneratorSchema,
    prompt_kodyrules_classifier_system,
    prompt_kodyrules_classifier_user,
    prompt_kodyrules_extract_id_system,
    prompt_kodyrules_extract_id_user,
    prompt_kodyrules_suggestiongeneration_system,
    prompt_kodyrules_suggestiongeneration_user,
    prompt_kodyrules_updatestdsuggestions_system,
    prompt_kodyrules_updatestdsuggestions_user,
} from '@libs/common/utils/prompts/kodyRules';
import { tryParseJSONObject } from '@libs/common/utils/transforms/json';
import {
    AIAnalysisResult,
    AnalysisContext,
    CodeReviewConfig,
    CodeSuggestion,
    DocumentationContextItem,
    FileChangeContext,
    ReviewModeResponse,
    ReviewOptions,
    SuggestionControlConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { KODY_RULES_SERVICE_TOKEN } from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRulesScope,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { ExternalReferenceLoaderService } from '@libs/kodyRules/infrastructure/adapters/services/externalReferenceLoader.service';
import { KodyRulesValidationService } from '../kodyRules/service/kody-rules-validation.service';
import { KodyRulesService } from '../kodyRules/service/kodyRules.service';

interface KodyRulesExtendedContext {
    pullRequest: any;
    patchWithLinesStr: string;
    maxSuggestionsParams?: number;
    language?: string;
    filePath: string;
    languageResultPrompt?: string;
    reviewOptions?: ReviewOptions;
    fileContent?: string;
    limitationType?: string;
    severityLevelFilter?: SeverityLevel;
    organizationAndTeamData: OrganizationAndTeamData;
    kodyRules: Array<Partial<IKodyRule>>;
    memories?: Array<Partial<IKodyRule>>;
    documentationContext?: DocumentationContextItem[];
    v2PromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
    contextAugmentations?: ContextAugmentationsMap;
    contextPack?: ContextPack;

    standardSuggestions?: AIAnalysisResult;
    updatedSuggestions?: AIAnalysisResult;
    filteredKodyRules?: Array<Partial<IKodyRule>>;
    externalReferencesMap?: Map<string, any[]>;
    mcpResultsMap?: Map<string, Record<string, unknown>>;
}

export const KODY_RULES_ANALYSIS_SERVICE_TOKEN = Symbol(
    'KodyRulesAnalysisService',
);

/**
 * Structured schema for the ID-extraction call (was a STRING parser whose raw
 * JSON was hand-parsed into `{ ids }`). `runStructuredReviewCall` always runs
 * `Output.object`, so the shape is declared explicitly and consumed directly.
 */
export const kodyRulesExtractIdSchema = z.object({
    ids: z.array(z.string()),
});

/**
 * Structured schema for the update-standard-suggestions call. It was a STRING
 * parser feeding `processUpdatedSuggestions(response: string)`; every field is
 * optional to keep the model output as permissive as the old free-form JSON.
 * `zodToStrictWireSchema` turns the optionals into nullable-required on the
 * wire, so a strict provider (OpenAI) still accepts it.
 */
export const kodyRulesUpdateSchema = z.object({
    codeSuggestions: z
        .array(
            z.object({
                id: z.string().optional(),
                relevantFile: z.string().optional(),
                language: z.string().optional(),
                suggestionContent: z.string().optional(),
                existingCode: z.string().optional(),
                improvedCode: z.string().optional(),
                oneSentenceSummary: z.string().optional(),
                relevantLinesStart: z
                    .union([z.number(), z.string()])
                    .optional(),
                relevantLinesEnd: z.union([z.number(), z.string()]).optional(),
                label: z.string().optional(),
                severity: z.string().optional(),
                violatedKodyRulesIds: z.array(z.string()).optional(),
                brokenKodyRulesIds: z.array(z.string()).optional(),
                llmPrompt: z.string().optional(),
            }),
        )
        .optional(),
});

@Injectable()
export class KodyRulesAnalysisService implements IKodyRulesAnalysisService {
    private readonly logger = createLogger(KodyRulesAnalysisService.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: KodyRulesService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly kodyRulesValidationService: KodyRulesValidationService,
        private readonly observabilityService: ObservabilityService,
        private readonly externalReferenceLoaderService: ExternalReferenceLoaderService,
    ) {}

    private async buildKodyRuleLinkAndRepalceIds(
        foundIds: string[],
        updatedContent: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<string> {
        for (const ruleId of foundIds) {
            try {
                const rule = await this.kodyRulesService.findById(ruleId);

                if (!rule) {
                    continue;
                }

                const baseUrl = process.env.API_USER_INVITE_BASE_URL || '';
                const ruleLink = buildKodyRuleLink(
                    baseUrl,
                    ruleId,
                    rule,
                    organizationAndTeamData,
                );

                const escapeMarkdownSyntax = (text: string): string =>
                    text.replace(/([[\\`*_{}()#+\-.!\]])/g, '\\$1');
                const markdownLink = `[${escapeMarkdownSyntax(rule.title)}](${ruleLink})`;

                // Check if ID is between single backticks `id`
                const singleBacktickPattern = new RegExp(
                    `\`${this.escapeRegex(ruleId)}\``,
                    'g',
                );
                if (singleBacktickPattern.test(updatedContent)) {
                    updatedContent = updatedContent.replace(
                        singleBacktickPattern,
                        markdownLink,
                    );
                    continue;
                }

                // Check if ID is between triple backticks ```id```
                const tripleBacktickPattern = new RegExp(
                    `\`\`\`${this.escapeRegex(ruleId)}\`\`\``,
                    'g',
                );
                if (tripleBacktickPattern.test(updatedContent)) {
                    updatedContent = updatedContent.replace(
                        tripleBacktickPattern,
                        markdownLink,
                    );
                    continue;
                }

                const idPattern = new RegExp(this.escapeRegex(ruleId), 'g');
                updatedContent = updatedContent.replace(
                    idPattern,
                    markdownLink,
                );
            } catch (error) {
                this.logger.error({
                    message: 'Error fetching Kody Rule details',
                    context: KodyRulesAnalysisService.name,
                    error: error,
                    metadata: {
                        ruleId,
                        organizationAndTeamData,
                        prNumber,
                    },
                });
                continue;
            }
        }

        return updatedContent;
    }

    // Helper function to escape special characters in regex
    private escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async replaceKodyRuleIdsWithLinks(
        suggestions: AIAnalysisResult,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        byokConfig?: NormalizedModel,
    ): Promise<AIAnalysisResult> {
        if (!suggestions?.codeSuggestions?.length) {
            return suggestions;
        }

        const updatedSuggestions = await Promise.all(
            suggestions.codeSuggestions.map(async (suggestion) => {
                try {
                    if (suggestion?.label === LabelType.KODY_RULES) {
                        let updatedContent =
                            suggestion?.suggestionContent || '';

                        const uuidRegex =
                            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
                        let foundIds: string[] =
                            updatedContent.match(uuidRegex) || [];

                        if (!foundIds?.length) {
                            let extractedIds: string[] = [];

                            const brokenIds = (suggestion as any)
                                ?.brokenKodyRulesIds;

                            const violatedIds = (suggestion as any)
                                ?.violatedKodyRulesIds;

                            if (suggestion?.suggestionContent) {
                                if (brokenIds?.length > 0) {
                                    const firstRuleId = brokenIds[0];
                                    updatedContent += `\n\nKody Rule violation: ${firstRuleId}`;
                                    foundIds = [firstRuleId];
                                } else if (violatedIds?.length > 0) {
                                    const firstRuleId = violatedIds[0];
                                    updatedContent += `\n\nKody Rule violation: ${firstRuleId}`;
                                    foundIds = [firstRuleId];
                                } else {
                                    extractedIds =
                                        await this.extractKodyRuleIdsFromContent(
                                            updatedContent,
                                            organizationAndTeamData,
                                            prNumber,
                                            suggestion,
                                            byokConfig,
                                        );
                                    if (extractedIds.length > 0) {
                                        foundIds = extractedIds;
                                    }
                                }
                            }
                        }

                        const updatedContentWithLinks =
                            await this.buildKodyRuleLinkAndRepalceIds(
                                foundIds,
                                updatedContent,
                                organizationAndTeamData,
                                prNumber,
                            );

                        return {
                            ...suggestion,
                            suggestionContent: updatedContentWithLinks,
                        };
                    }

                    return suggestion;
                } catch (error) {
                    this.logger.error({
                        message:
                            'Error processing suggestion for Kody Rule links',
                        context: KodyRulesAnalysisService.name,
                        error,
                        metadata: {
                            suggestionId: suggestion.id,
                            organizationAndTeamData,
                            prNumber,
                        },
                    });
                    return suggestion;
                }
            }),
        );

        return {
            ...suggestions,
            codeSuggestions: updatedSuggestions,
        };
    }

    private async extractKodyRuleIdsFromContent(
        updatedContent: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        suggestion: Partial<CodeSuggestion>,
        byokConfig?: NormalizedModel,
    ): Promise<string[]> {
        try {
            const runName = 'extractKodyRuleIdsFromContent';

            const extraction = await LLM.run({
                byokConfig,
                schema: kodyRulesExtractIdSchema,
                system: prompt_kodyrules_extract_id_system(),
                user: prompt_kodyrules_extract_id_user({
                    suggestionContent: updatedContent,
                }),
                runName: `${KodyRulesAnalysisService.name}::${runName}`,
                organizationId: organizationAndTeamData?.organizationId,
                attrs: {
                    teamId: organizationAndTeamData?.teamId,
                    prNumber,
                    suggestionId: suggestion?.id,
                },
            });

            if (extraction?.ids?.length) {
                return extraction.ids;
            }

            this.logger.warn({
                message: `No Kody Rule IDs extracted from content for PR#${prNumber}`,
                context: KodyRulesAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    suggestionId: suggestion.id,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error in LLM fallback for ID extraction',
                context: KodyRulesAnalysisService.name,
                error,
                metadata: {
                    suggestionId: suggestion.id,
                    organizationAndTeamData,
                    prNumber,
                },
            });
        }

        return [];
    }

    async analyzeCodeWithAI(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        fileContext: FileChangeContext,
        reviewModeResponse: ReviewModeResponse.HEAVY_MODE,
        context: AnalysisContext,
        suggestions?: AIAnalysisResult,
    ): Promise<AIAnalysisResult> {
        const hasCodeSuggestions =
            !!suggestions &&
            !!suggestions?.codeSuggestions &&
            suggestions?.codeSuggestions?.length > 0;
        // Retained only as an observability label for the downstream
        // token-usage log. Actual model selection now flows through
        // `runStructuredReviewCall` (org BYOK, or the managed review default).
        const provider = LLMModelProvider.GEMINI_2_5_PRO;

        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );

        if (!baseContext.kodyRules?.length) {
            this.logger.log({
                message: `No Kody Rules applicable for file: ${fileContext?.file?.filename} from PR#${prNumber}`,
                context: KodyRulesAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    filename: fileContext?.file?.filename,
                    kodyRulesCount: baseContext.kodyRules?.length || 0,
                },
            });

            return { codeSuggestions: [] };
        }

        const { referencesMap: externalReferencesMap } =
            await this.externalReferenceLoaderService.loadReferencesForRules(
                baseContext.kodyRules,
                context,
            );

        const rulesWithLoadedReferences = baseContext.kodyRules.filter(
            (rule) => {
                const fullRule = rule as Partial<IKodyRule>;
                if (!fullRule.contextReferenceId) {
                    return true;
                }

                if (fullRule.uuid) {
                    const hasKnowledge = externalReferencesMap.has(
                        fullRule.uuid,
                    );

                    if (hasKnowledge) {
                        return true;
                    }
                }

                this.logger.warn({
                    message:
                        'Skipping rule with contextReferenceId that failed to load references or MCP results',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        ruleUuid: fullRule.uuid,
                        ruleTitle: fullRule.title,
                        contextReferenceId: fullRule.contextReferenceId,
                    },
                });

                return false;
            },
        );

        if (rulesWithLoadedReferences.length === 0) {
            this.logger.log({
                message: `No rules with external context (knowledge or MCP) for file: ${fileContext?.file?.filename}`,
                context: KodyRulesAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    filename: fileContext?.file?.filename,
                },
            });
            return { codeSuggestions: [] };
        }

        baseContext.kodyRules = rulesWithLoadedReferences;

        let extendedContext = {
            ...baseContext,
            standardSuggestions: hasCodeSuggestions ? suggestions : undefined,
            updatedSuggestions: undefined,
            filteredKodyRules: undefined,
            externalReferencesMap,
        };

        const byokConfig = context?.codeReviewConfig?.byokConfig;
        const organizationId = organizationAndTeamData?.organizationId;

        try {
            // Each structured call now carries its own AI-SDK span internally
            // (runStructuredReviewCall). The former single `runLLMInSpan`
            // wrapper is dropped so there is exactly one span per call (Q4 /
            // T-03-09) instead of an outer wrapper double-counting usage.
            const [classifiedRulesResult, updateStandardSuggestionsResult] =
                await Promise.all([
                    this.runClassifier(
                        extendedContext,
                        byokConfig,
                        organizationId,
                        prNumber,
                    ),
                    hasCodeSuggestions
                        ? this.runUpdater(
                              extendedContext,
                              byokConfig,
                              organizationId,
                              prNumber,
                          )
                        : Promise.resolve(undefined),
                ]);

            const classifiedRules = this.processClassifierResponse(
                baseContext.kodyRules,
                classifiedRulesResult,
            );

            const updatedSuggestions = this.processUpdatedSuggestions(
                organizationAndTeamData,
                prNumber,
                updateStandardSuggestionsResult,
                fileContext,
                provider,
                extendedContext,
            );

            if (!classifiedRules || classifiedRules?.length === 0) {
                if (updatedSuggestions) {
                    return this.addSeverityToSuggestions(
                        updatedSuggestions,
                        context?.codeReviewConfig?.kodyRules || [],
                    );
                }
                return { codeSuggestions: [] };
            }

            extendedContext = {
                ...extendedContext,
                filteredKodyRules: classifiedRules,
                updatedSuggestions: updatedSuggestions ?? undefined,
            };

            const generatedKodyRulesSuggestionsResult =
                await this.runGenerator(
                    extendedContext,
                    byokConfig,
                    organizationId,
                    prNumber,
                );

            const generatedKodyRulesSuggestions = this.processLLMResponse(
                organizationAndTeamData,
                prNumber,
                generatedKodyRulesSuggestionsResult,
                fileContext,
                provider,
                extendedContext,
            );

            const finalOutput: AIAnalysisResult = {
                codeSuggestions: [
                    ...(generatedKodyRulesSuggestions?.codeSuggestions ?? []),
                ],
            };

            if (updatedSuggestions) {
                finalOutput.codeSuggestions = [
                    ...finalOutput.codeSuggestions,
                    ...(updatedSuggestions?.codeSuggestions ?? []),
                ];
            }

            const finalOutputWithLinks = await this.replaceKodyRuleIdsWithLinks(
                finalOutput,
                organizationAndTeamData,
                prNumber,
                context?.codeReviewConfig?.byokConfig,
            );

            return this.addSeverityToSuggestions(
                finalOutputWithLinks,
                context?.codeReviewConfig?.kodyRules || [],
            );
        } catch (error) {
            this.logger.error({
                message: `Error during LLM code analysis for PR#${prNumber}`,
                context: KodyRulesAnalysisService.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
                error,
            });
            throw error;
        }
    }

    /**
     * Classifier call — determines which Kody Rules are violated. Runs a single
     * structured call on the org's BYOK model (or the managed review default),
     * returning the parsed classifier object consumed by
     * `processClassifierResponse`.
     */
    private runClassifier(
        context: KodyRulesExtendedContext,
        byokConfig: NormalizedModel | undefined,
        organizationId: string | undefined,
        prNumber: number,
    ): Promise<KodyRulesClassifierSchema> {
        return LLM.run({
            byokConfig,
            schema: kodyRulesClassifierSchema,
            system: prompt_kodyrules_classifier_system(),
            user: prompt_kodyrules_classifier_user(context),
            runName: `${KodyRulesAnalysisService.name}::classifierKodyRulesAnalyzeCodeWithAI`,
            organizationId,
            attrs: {
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: prNumber,
            },
        });
    }

    /**
     * Update-standard-suggestions call. The downstream
     * `processUpdatedSuggestions` still parses a JSON STRING (kept byte-for-byte
     * across the migration), so the structured result is re-serialized to
     * preserve that contract exactly.
     */
    private async runUpdater(
        context: KodyRulesExtendedContext,
        byokConfig: NormalizedModel | undefined,
        organizationId: string | undefined,
        prNumber: number,
    ): Promise<string> {
        const result = await LLM.run({
            byokConfig,
            schema: kodyRulesUpdateSchema,
            system: prompt_kodyrules_updatestdsuggestions_system(),
            user: prompt_kodyrules_updatestdsuggestions_user(context),
            runName: `${KodyRulesAnalysisService.name}::updateStandardSuggestionsAnalyzeCodeWithAI`,
            organizationId,
            attrs: {
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: prNumber,
            },
        });

        return JSON.stringify(result ?? {});
    }

    /**
     * Suggestion-generation call — produces the Kody-Rules code suggestions.
     * Returns the parsed generator object consumed by `processLLMResponse`.
     */
    private runGenerator(
        context: KodyRulesExtendedContext,
        byokConfig: NormalizedModel | undefined,
        organizationId: string | undefined,
        prNumber: number,
    ): Promise<z.infer<typeof kodyRulesGeneratorSchema>> {
        return LLM.run({
            byokConfig,
            schema: kodyRulesGeneratorSchema,
            system: prompt_kodyrules_suggestiongeneration_system(),
            user: prompt_kodyrules_suggestiongeneration_user(context),
            runName: `${KodyRulesAnalysisService.name}::suggestionGenerationKodyRulesAnalyzeCodeWithAI`,
            organizationId,
            attrs: {
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: prNumber,
            },
        });
    }

    private addSeverityToSuggestions(
        suggestions: AIAnalysisResult,
        kodyRules: Array<Partial<IKodyRule>>,
    ): AIAnalysisResult {
        if (!suggestions?.codeSuggestions?.length || !kodyRules?.length) {
            return suggestions;
        }

        const updatedSuggestions = suggestions.codeSuggestions.map(
            (
                suggestion: Partial<CodeSuggestion> & {
                    brokenKodyRulesIds?: string[];
                },
            ) => {
                if (!suggestion.brokenKodyRulesIds?.length) {
                    return suggestion;
                }

                // For each broken rule, find the severity in kodyRules
                const severities = suggestion.brokenKodyRulesIds
                    .map((ruleId) => {
                        const rule = kodyRules.find((kr) => kr.uuid === ruleId);
                        return rule?.severity;
                    })
                    .filter(Boolean);

                // If there are severities, use the first one
                if (severities && severities.length > 0) {
                    return {
                        ...suggestion,
                        severity: severities[0]?.toLowerCase(),
                    };
                }

                return suggestion;
            },
        );

        return {
            ...suggestions,
            codeSuggestions: updatedSuggestions,
        };
    }

    private async prepareAnalysisContext(
        fileContext: FileChangeContext,
        context: AnalysisContext,
    ) {
        let directoryId = context?.codeReviewConfig?.directoryId;
        if (!directoryId) {
            directoryId =
                await this.codeBaseConfigService.getDirectoryIdForPath(
                    context?.organizationAndTeamData,
                    {
                        id: context?.repository?.id || '',
                        name: context?.repository?.name || '',
                    },
                    fileContext?.file?.filename || '',
                );
        }

        const kodyRulesFiltered = this.kodyRulesValidationService
            .getKodyRulesForFile(
                fileContext.file.filename,
                context?.codeReviewConfig?.kodyRules || [],
                {
                    ...(directoryId
                        ? { directoryId }
                        : { repositoryId: context?.repository?.id }),
                },
            )
            ?.filter(
                (rule) => !rule.scope || rule.scope === KodyRulesScope.FILE,
            )
            ?.map((rule) => ({
                uuid: rule?.uuid,
                title: rule?.title,
                rule: rule?.rule,
                severity: rule?.severity,
                examples: rule?.examples ?? [],
                contextReferenceId: rule?.contextReferenceId,
            }));

        // Grep-able evaluation trace ("[kody-rules-eval]"): the single
        // authoritative record of WHICH rules entered the prompt for this
        // file. Self-hosted operators debugging "why didn't my rule fire"
        // previously had no way to tell a rule dropped by path/scope
        // filtering from a rule the model simply ignored.
        this.logger.log({
            message: `[kody-rules-eval] ${kodyRulesFiltered?.length ?? 0} rule(s) selected for file ${fileContext?.file?.filename}`,
            context: KodyRulesAnalysisService.name,
            metadata: {
                organizationAndTeamData: context?.organizationAndTeamData,
                prNumber: context?.pullRequest?.number,
                filename: fileContext?.file?.filename,
                totalActiveRules:
                    context?.codeReviewConfig?.kodyRules?.length ?? 0,
                selectedRules: (kodyRulesFiltered ?? []).map((r) => ({
                    uuid: r.uuid,
                    title: r.title,
                })),
            },
        });

        const baseContext = {
            pullRequest: context?.pullRequest,
            patchWithLinesStr: fileContext?.patchWithLinesStr,
            maxSuggestionsParams:
                context?.codeReviewConfig?.suggestionControl?.maxSuggestions,
            language: context?.repository?.language,
            filePath: fileContext?.file?.filename,
            languageResultPrompt:
                context?.codeReviewConfig?.languageResultPrompt,
            reviewOptions: context?.codeReviewConfig?.reviewOptions,
            fileContent: fileContext?.file?.fileContent,
            limitationType:
                context?.codeReviewConfig?.suggestionControl?.limitationType,
            // ✨ MODIFICATION: only pass severityLevelFilter if filters should be applied
            severityLevelFilter: this.shouldPassSeverityFilter(
                context?.codeReviewConfig?.suggestionControl,
            )
                ? context?.codeReviewConfig?.suggestionControl
                      ?.severityLevelFilter
                : undefined,
            organizationAndTeamData: context?.organizationAndTeamData,
            kodyRules: kodyRulesFiltered,
            memories: context?.codeReviewConfig?.kodyMemoryRules || [],
            v2PromptOverrides:
                context?.activeOverrides ??
                getOverridesFromPack(context?.sharedContextPack) ??
                context?.codeReviewConfig?.v2PromptOverrides,
            externalPromptLayers: context?.externalPromptLayers,
            contextAugmentations: {
                ...(getAugmentationsFromPack(context?.sharedContextPack) ?? {}),
                ...(context?.fileAugmentations ?? {}),
            } as ContextAugmentationsMap,
            contextPack: context?.sharedContextPack as ContextPack | undefined,
            documentationContext: context?.documentationContext || [],
        };

        return baseContext;
    }

    /**
     * ✨ SIMPLIFIED: Determines if severityLevelFilter should be passed for Kody Rules analysis
     */
    private shouldPassSeverityFilter(
        suggestionControl?: SuggestionControlConfig,
    ): boolean {
        if (!suggestionControl) {
            return false;
        }

        // Returns true only if filters are explicitly enabled for Kody Rules
        return suggestionControl.applyFiltersToKodyRules === true;
    }

    private processClassifierResponse(
        allRules: Array<Partial<IKodyRule> | IKodyRule>,
        response: KodyRulesClassifierSchema,
    ): Array<Partial<IKodyRule> | IKodyRule> | null {
        try {
            if (!response || !response.rules?.length) {
                this.logger.warn({
                    message: 'No rules found in classifier response',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        allRules,
                        response,
                    },
                });
                return null;
            }

            const responseMap = new Map(
                response.rules.map((rule) => [rule.uuid, rule.reason]),
            );

            return allRules
                .filter((rule) => rule.uuid && responseMap.has(rule.uuid))
                .map((rule) => {
                    const baseRule = { ...rule };
                    const reason = responseMap.get(rule.uuid!);
                    return { ...baseRule, reason } as Partial<IKodyRule>;
                });
        } catch (error) {
            this.logger.error({
                message: 'Error processing classifier response',
                context: KodyRulesAnalysisService.name,
                error,
                metadata: {
                    allRules,
                    response,
                },
            });
            return null;
        }
    }

    private processSuggestionLabels(
        suggestions: CodeSuggestion[],
        reviewOptions: ReviewOptions,
    ): CodeSuggestion[] {
        const availableLabels = Object.keys(reviewOptions);

        return suggestions.map((suggestion) => {
            if (
                (suggestion.label ?? '') === '' ||
                !availableLabels.includes(suggestion?.label)
            ) {
                return {
                    ...suggestion,
                    label: 'kody_rules',
                };
            }

            return suggestion;
        });
    }

    private processLLMResponse(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        response: any,
        fileContext: FileChangeContext,
        provider: LLMModelProvider,
        extendedContext: KodyRulesExtendedContext,
    ): AIAnalysisResult | null {
        try {
            if (!response) {
                return null;
            }

            // Normalize the types of fields that may come as strings
            if (response?.codeSuggestions) {
                response.codeSuggestions = response.codeSuggestions.map(
                    (suggestion) => {
                        if (!suggestion?.id || !uuidValidate(suggestion?.id)) {
                            return {
                                ...suggestion,
                                id: uuidv4(),
                            };
                        }
                        return suggestion;
                    },
                );

                if (extendedContext?.reviewOptions) {
                    response.codeSuggestions = this.processSuggestionLabels(
                        response.codeSuggestions,
                        extendedContext.reviewOptions,
                    );
                } else {
                    response.codeSuggestions = response.codeSuggestions.map(
                        (suggestion) => ({
                            ...suggestion,
                            label: suggestion.label ?? 'kody_rules',
                        }),
                    );
                }
            }

            this.logTokenUsage({
                tokenUsages: response.codeSuggestions,
                pullRequestId: prNumber,
                fileContext: fileContext?.file?.filename,
                provider,
                organizationAndTeamData,
            });

            return {
                codeSuggestions: response.codeSuggestions || [],
            };
        } catch (error) {
            this.logger.error({
                message: `Error processing LLM response for PR#${prNumber}`,
                context: KodyRulesAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    response,
                },
            });
            return null;
        }
    }

    /**
     * Specifically processes updatedSuggestions with differentiated logic
     * for violated vs broken kody rules
     */
    private processUpdatedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        response: string,
        fileContext: FileChangeContext,
        _provider: LLMModelProvider,
        _extendedContext: KodyRulesExtendedContext,
    ): AIAnalysisResult | null {
        // Tipo específico para a resposta do UPDATE
        interface KodyRulesUpdateResponse {
            codeSuggestions?: Array<{
                id?: string;
                relevantFile?: string;
                language?: string;
                suggestionContent?: string;
                existingCode?: string;
                improvedCode?: string;
                oneSentenceSummary?: string;
                relevantLinesStart?: number | string;
                relevantLinesEnd?: number | string;
                label?: string;
                severity?: string;
                violatedKodyRulesIds?: string[];
                brokenKodyRulesIds?: string[];
                llmPrompt?: string;
            }>;
        }

        try {
            if (!response) {
                return null;
            }

            let cleanResponse = response;
            if (response?.startsWith('```')) {
                cleanResponse = response
                    .replace(/^```json\n/, '')
                    .replace(/\n```(\n)?$/, '')
                    .trim();
            }

            const parsedResponse = tryParseJSONObject(
                cleanResponse,
            ) as KodyRulesUpdateResponse | null;

            if (!parsedResponse) {
                this.logger.error({
                    message: 'Failed to parse UPDATE response',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        originalResponse: response,
                        cleanResponse,
                        prNumber,
                    },
                });
                return null;
            }

            const processedSuggestions: CodeSuggestion[] = [];

            if (parsedResponse.codeSuggestions) {
                for (const suggestion of parsedResponse.codeSuggestions) {
                    const normalizedSuggestion: CodeSuggestion = {
                        id:
                            !suggestion?.id || !uuidValidate(suggestion?.id)
                                ? uuidv4()
                                : suggestion.id,
                        relevantFile: suggestion.relevantFile || '',
                        language: suggestion.language,
                        suggestionContent: suggestion.suggestionContent || '',
                        existingCode: suggestion.existingCode,
                        improvedCode: suggestion.improvedCode,
                        oneSentenceSummary: suggestion.oneSentenceSummary,
                        relevantLinesStart:
                            Number(suggestion.relevantLinesStart) || undefined,
                        relevantLinesEnd:
                            Number(suggestion.relevantLinesEnd) || undefined,
                        label: suggestion.label,
                        severity: suggestion.severity,
                        llmPrompt: suggestion.llmPrompt,
                    };

                    // "Has violated" means a standard suggestion violates a kody rule, so we silently fix it.
                    const hasViolated =
                        suggestion.violatedKodyRulesIds?.length &&
                        suggestion.violatedKodyRulesIds.length > 0;

                    // "Has broken" means that a standard suggestion could potentially be a kody rule, so we merge it
                    const hasBroken =
                        suggestion.brokenKodyRulesIds?.length &&
                        suggestion.brokenKodyRulesIds.length > 0;

                    if (hasBroken) {
                        processedSuggestions.push({
                            ...normalizedSuggestion,
                            label: 'kody_rules',
                            brokenKodyRulesIds: suggestion.brokenKodyRulesIds,
                        });
                    } else if (hasViolated) {
                        processedSuggestions.push({
                            ...normalizedSuggestion,
                            label: suggestion.label,
                            // violatedKodyRulesIds is just for internal use, so we don't save it
                        });
                    } else {
                        processedSuggestions.push(normalizedSuggestion);
                    }
                }
            }

            return {
                codeSuggestions: processedSuggestions,
            };
        } catch (error) {
            this.logger.error({
                message: `Error processing UPDATE response for PR#${prNumber}`,
                context: KodyRulesAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    response,
                    filename: fileContext?.file?.filename,
                },
            });
            return null;
        }
    }

    private async logTokenUsage(metadata: any) {
        // Log token usage for analysis and monitoring
        this.logger.log({
            message: 'Token usage',
            context: KodyRulesAnalysisService.name,
            metadata: {
                ...metadata,
            },
        });
    }
}
