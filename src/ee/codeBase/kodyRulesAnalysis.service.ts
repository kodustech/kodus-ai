import {
    AIAnalysisResult,
    AnalysisContext,
    CodeReviewConfig,
    CodeSuggestion,
    FileChangeContext,
    ReviewModeResponse,
    ReviewOptions,
    SuggestionControlConfig,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@/core/domain/codeBase/contracts/CodeBaseConfigService.contract';
import { IKodyRulesAnalysisService } from '@/core/domain/codeBase/contracts/KodyRulesAnalysisService.contract';
import { KODY_RULES_SERVICE_TOKEN } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRulesScope,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import type { ContextAugmentationsMap } from '@/core/infrastructure/adapters/services/context/code-review-context-pack.service';
import {
    getAugmentationsFromPack,
    getOverridesFromPack,
} from '@/core/infrastructure/adapters/services/context/code-review-context.utils';
import { FileContextAugmentationService } from '@/core/infrastructure/adapters/services/context/file-context-augmentation.service';
import { ExternalReferenceLoaderService } from '@/core/infrastructure/adapters/services/kodyRules/externalReferenceLoader.service';
import { KodyRuleDependencyService } from '@/core/infrastructure/adapters/services/kodyRules/kodyRulesDependency.service';
import { ObservabilityService } from '@/core/infrastructure/adapters/services/logger/observability.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { BYOKPromptRunnerService } from '@/shared/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { LabelType } from '@/shared/utils/codeManagement/labels';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import {
    KodyRulesClassifierSchema,
    kodyRulesClassifierSchema,
    kodyRulesGeneratorSchema,
    prompt_kodyrules_classifier_system,
    prompt_kodyrules_classifier_user,
    prompt_kodyrules_extract_id_system,
    prompt_kodyrules_extract_id_user,
    prompt_kodyrules_guardian_system,
    prompt_kodyrules_guardian_user,
    prompt_kodyrules_suggestiongeneration_system,
    prompt_kodyrules_suggestiongeneration_user,
    prompt_kodyrules_updatestdsuggestions_system,
    prompt_kodyrules_updatestdsuggestions_user,
} from '@/shared/utils/langchainCommon/prompts/kodyRules';
import { tryParseJSONObject } from '@/shared/utils/transforms/json';
import type {
    ContextDependency,
    ContextPack,
} from '@context-os-core/interfaces';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
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

@Injectable()
export class KodyRulesAnalysisService implements IKodyRulesAnalysisService {
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: KodyRulesService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly promptRunnerService: PromptRunnerService,
        private readonly kodyRulesValidationService: KodyRulesValidationService,
        private readonly logger: PinoLoggerService,
        private readonly observabilityService: ObservabilityService,
        private readonly externalReferenceLoaderService: ExternalReferenceLoaderService,
        private readonly fileContextAugmentationService: FileContextAugmentationService,
        private readonly kodyRuleDependencyService: KodyRuleDependencyService,
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
                let ruleLink: string;

                if (rule.repositoryId === 'global') {
                    ruleLink = `${baseUrl}/settings/code-review/global/kody-rules/${ruleId}`;
                } else {
                    ruleLink = `${baseUrl}/settings/code-review/${rule.repositoryId}/kody-rules/${ruleId}`;
                }

                const escapeMarkdownSyntax = (text: string): string =>
                    text.replace(/([\[\]\\`*_{}()#+\-.!])/g, '\\$1');
                const markdownLink = `[${escapeMarkdownSyntax(rule.title)}](${ruleLink})`;

                // Verificar se o ID está entre crases simples `id`
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

                // Verificar se o ID está entre blocos de código ```id```
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

    // Função auxiliar para escapar caracteres especiais no regex
    private escapeRegex(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async replaceKodyRuleIdsWithLinks(
        suggestions: AIAnalysisResult,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        byokConfig?: BYOKConfig,
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
        byokConfig?: BYOKConfig,
    ): Promise<string[]> {
        try {
            const provider = LLMModelProvider.GEMINI_2_5_FLASH;
            const fallbackProvider = LLMModelProvider.GEMINI_2_5_PRO;

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                provider,
                fallbackProvider,
                byokConfig,
            );

            const runName = 'extractKodyRuleIdsFromContent';
            const spanName = `${KodyRulesAnalysisService.name}::${runName}`;
            const spanAttrs = {
                type: promptRunner.executeMode,
                organizationId: organizationAndTeamData?.organizationId,
                teamId: organizationAndTeamData?.teamId,
                prNumber,
                suggestionId: suggestion?.id,
            };

            const { result: extraction } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    exec: async (callbacks) => {
                        return await promptRunner
                            .builder()
                            .setParser(ParserType.STRING)
                            .setLLMJsonMode(true)
                            .setPayload({ suggestionContent: updatedContent })
                            .addPrompt({
                                prompt: prompt_kodyrules_extract_id_system,
                                role: PromptRole.SYSTEM,
                            })
                            .addPrompt({
                                prompt: prompt_kodyrules_extract_id_user,
                                role: PromptRole.USER,
                            })
                            .addMetadata({
                                organizationId:
                                    organizationAndTeamData?.organizationId,
                                teamId: organizationAndTeamData?.teamId,
                                pullRequestId: prNumber,
                                provider:
                                    byokConfig?.main?.provider || provider,
                                fallbackProvider:
                                    byokConfig?.fallback?.provider ||
                                    fallbackProvider,
                                model: byokConfig?.main?.model,
                                fallbackModel: byokConfig?.fallback?.model,
                                runName,
                            })
                            .addTags([
                                ...this.buildTags(provider, 'primary'),
                                ...this.buildTags(fallbackProvider, 'fallback'),
                            ])
                            .addCallbacks(callbacks)
                            .setRunName(runName)
                            .setTemperature(0)
                            .execute();
                    },
                });

            if (!extraction) {
                const message = `No Kody Rule IDs extracted from content for PR#${prNumber}`;
                this.logger.warn({
                    message,
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        suggestionId: suggestion.id,
                    },
                });
                throw new Error(message);
            }

            if (extraction) {
                const cleanResponse = extraction.replace(/```json\n|```/g, '');
                const parsedIds = tryParseJSONObject(cleanResponse);

                if (parsedIds?.ids?.length) {
                    return parsedIds.ids;
                }
            }
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

    private buildMcpResultsFromAugmentations(
        augmentationsByFile: Record<string, ContextAugmentationsMap>,
        rules: Array<Partial<IKodyRule>>,
        mcpDependencies: ContextDependency[],
    ): Map<string, Record<string, unknown>> {
        const mcpResultsMap = new Map<string, Record<string, unknown>>();
        if (
            !mcpDependencies ||
            mcpDependencies.length === 0 ||
            Object.keys(augmentationsByFile).length === 0
        ) {
            return mcpResultsMap;
        }

        const dependenciesByRule = new Map<string, ContextDependency[]>();
        for (const rule of rules) {
            if (rule.uuid && rule.contextReferenceId) {
                const ruleDependencies = mcpDependencies.filter(
                    (dep) =>
                        dep.metadata?.contextReferenceId ===
                        rule.contextReferenceId,
                );
                if (ruleDependencies.length > 0) {
                    dependenciesByRule.set(rule.uuid, ruleDependencies);
                }
            }
        }

        for (const [ruleId, dependencies] of dependenciesByRule.entries()) {
            const ruleAugmentations: Record<string, unknown> = {};
            for (const dep of dependencies) {
                for (const fileName in augmentationsByFile) {
                    const fileAugmentations = augmentationsByFile[fileName];
                    for (const pathKey in fileAugmentations) {
                        if (!ruleAugmentations[pathKey]) {
                            ruleAugmentations[pathKey] = { outputs: [] };
                        }
                        (ruleAugmentations[pathKey] as any).outputs.push(
                            ...fileAugmentations[pathKey].outputs,
                        );
                    }
                }
            }
            if (Object.keys(ruleAugmentations).length > 0) {
                mcpResultsMap.set(ruleId, ruleAugmentations);
            }
        }

        return mcpResultsMap;
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
        const provider = LLMModelProvider.GEMINI_2_5_PRO;
        const fallbackProvider = LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET;

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

        const augmentationsByFile: Record<string, ContextAugmentationsMap> = {};
        for (const rule of baseContext.kodyRules) {
            if (!rule.contextReferenceId) {
                continue;
            }

            const ruleDependencies =
                await this.kodyRuleDependencyService.getMcpDependenciesForRules(
                    [rule],
                );

            if (ruleDependencies.length > 0) {
                const ruleAugmentations =
                    await this.fileContextAugmentationService.augmentFiles(
                        [fileContext.file],
                        context as any,
                        ruleDependencies,
                        rule,
                    );

                for (const fileName in ruleAugmentations) {
                    if (!augmentationsByFile[fileName]) {
                        augmentationsByFile[fileName] = {};
                    }
                    Object.assign(
                        augmentationsByFile[fileName],
                        ruleAugmentations[fileName],
                    );
                }
            }
        }

        const allMcpDependencies =
            await this.kodyRuleDependencyService.getMcpDependenciesForRules(
                baseContext.kodyRules,
            );

        const mcpResultsMap = this.buildMcpResultsFromAugmentations(
            augmentationsByFile,
            baseContext.kodyRules,
            allMcpDependencies,
        );

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
                    const hasMcp = mcpResultsMap.has(fullRule.uuid);

                    if (hasKnowledge || hasMcp) {
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
            mcpResultsMap,
        };

        const runName = 'kodyRulesAnalyzeCodeWithAI';
        const spanName = `${KodyRulesAnalysisService.name}::${runName}`;

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            context?.codeReviewConfig?.byokConfig,
        );

        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            file: { name: fileContext?.file?.filename },
        };

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName,
                runName,
                attrs: spanAttrs,
                exec: async (callbacks) => {
                    const classifier = this.getClassifier(
                        promptRunner,
                        provider,
                        fallbackProvider,
                        extendedContext,
                        context?.codeReviewConfig?.byokConfig,
                        callbacks,
                    );
                    const updater = this.getUpdater(
                        promptRunner,
                        provider,
                        fallbackProvider,
                        extendedContext,
                        context?.codeReviewConfig?.byokConfig,
                        callbacks,
                    );

                    const [
                        classifiedRulesResult,
                        updateStandardSuggestionsResult,
                    ] = await Promise.all([
                        classifier.execute(),
                        hasCodeSuggestions
                            ? updater?.execute()
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
                            const out = this.addSeverityToSuggestions(
                                updatedSuggestions,
                                context?.codeReviewConfig?.kodyRules || [],
                            );
                            return { shortCircuit: true, output: out };
                        }
                        return {
                            shortCircuit: true,
                            output: { codeSuggestions: [] },
                        };
                    }

                    extendedContext = {
                        ...extendedContext,
                        filteredKodyRules: classifiedRules,
                        updatedSuggestions: updatedSuggestions ?? undefined,
                    };

                    const generator = this.getGenerator(
                        promptRunner,
                        provider,
                        fallbackProvider,
                        extendedContext,
                        context?.codeReviewConfig?.byokConfig,
                        callbacks,
                    );

                    const generatedKodyRulesSuggestionsResult =
                        await generator.execute();

                    return {
                        shortCircuit: false,
                        generatedKodyRulesSuggestionsResult,
                        updatedSuggestions,
                    };
                },
            });

            if (result?.shortCircuit) {
                return result.output as AIAnalysisResult;
            }

            const generatedKodyRulesSuggestions = this.processLLMResponse(
                organizationAndTeamData,
                prNumber,
                result.generatedKodyRulesSuggestionsResult,
                fileContext,
                provider,
                extendedContext,
            );

            let finalOutput: AIAnalysisResult = {
                codeSuggestions: [
                    ...(generatedKodyRulesSuggestions?.codeSuggestions ?? []),
                ],
            };

            if (result?.updatedSuggestions) {
                finalOutput.codeSuggestions = [
                    ...finalOutput.codeSuggestions,
                    ...(result.updatedSuggestions?.codeSuggestions ?? []),
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

    private getClassifier(
        promptRunner: BYOKPromptRunnerService,
        provider: LLMModelProvider,
        fallbackProvider: LLMModelProvider,
        context: KodyRulesExtendedContext,
        byokConfig?: BYOKConfig,
        callbacks?: any[],
    ) {
        const builder = promptRunner
            .builder()
            .setParser(ParserType.ZOD, kodyRulesClassifierSchema, {
                provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
            })
            .setLLMJsonMode(true)
            .setTemperature(0)
            .setPayload(context)
            .addPrompt({
                prompt: prompt_kodyrules_classifier_system,
                role: PromptRole.SYSTEM,
            })
            .addPrompt({
                prompt: prompt_kodyrules_classifier_user,
                role: PromptRole.USER,
            })
            .addMetadata({
                organizationId:
                    context?.organizationAndTeamData?.organizationId,
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: context?.pullRequest?.number,
                provider: byokConfig?.main?.provider || provider,
                fallbackProvider:
                    byokConfig?.fallback?.provider || fallbackProvider,
                model: byokConfig?.main?.model,
                fallbackModel: byokConfig?.fallback?.model,
                runName: 'classifierKodyRulesAnalyzeCodeWithAI',
            })
            .addTags([
                ...this.buildTags(provider, 'primary'),
                ...this.buildTags(fallbackProvider, 'fallback'),
            ])
            .setRunName('classifierKodyRulesAnalyzeCodeWithAI');

        if (callbacks?.length) {
            builder.addCallbacks(callbacks);
        }

        return builder;
    }

    private getUpdater(
        promptRunner: BYOKPromptRunnerService,
        provider: LLMModelProvider,
        fallbackProvider: LLMModelProvider,
        context: KodyRulesExtendedContext,
        byokConfig?: BYOKConfig,
        callbacks?: any[],
    ) {
        const builder = promptRunner
            .builder()
            .setParser(ParserType.STRING)
            .setLLMJsonMode(true)
            .setTemperature(0)
            .setPayload(context)
            .addPrompt({
                prompt: prompt_kodyrules_updatestdsuggestions_system,
                role: PromptRole.SYSTEM,
            })
            .addPrompt({
                prompt: prompt_kodyrules_updatestdsuggestions_user,
                role: PromptRole.USER,
            })
            .addMetadata({
                organizationId:
                    context?.organizationAndTeamData?.organizationId,
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: context?.pullRequest?.number,
                provider: byokConfig?.main?.provider || provider,
                fallbackProvider:
                    byokConfig?.fallback?.provider || fallbackProvider,
                model: byokConfig?.main?.model,
                fallbackModel: byokConfig?.fallback?.model,
                runName: 'updateStandardSuggestionsAnalyzeCodeWithAI',
            })
            .addTags([
                ...this.buildTags(provider, 'primary'),
                ...this.buildTags(fallbackProvider, 'fallback'),
            ])
            .setRunName('updateStandardSuggestionsAnalyzeCodeWithAI');

        if (callbacks?.length) {
            builder.addCallbacks(callbacks);
        }

        return builder;
    }

    private getGuardian(
        promptRunner: BYOKPromptRunnerService,
        provider: LLMModelProvider,
        fallbackProvider: LLMModelProvider,
        context: KodyRulesExtendedContext,
        byokConfig?: BYOKConfig,
        callbacks?: any[],
    ) {
        const builder = promptRunner
            .builder()
            .setParser(ParserType.STRING) // mantém a lógica atual
            .setLLMJsonMode(true) // idem
            .setTemperature(0)
            .setPayload(context)
            .addPrompt({
                prompt: prompt_kodyrules_guardian_system,
                role: PromptRole.SYSTEM,
            })
            .addPrompt({
                prompt: prompt_kodyrules_guardian_user,
                role: PromptRole.USER,
            })
            .addMetadata({
                organizationId:
                    context?.organizationAndTeamData?.organizationId,
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: context?.pullRequest?.number,
                provider: byokConfig?.main?.provider || provider,
                fallbackProvider:
                    byokConfig?.fallback?.provider || fallbackProvider,
                model: byokConfig?.main?.model,
                fallbackModel: byokConfig?.fallback?.model,
                runName: 'guardianKodyRulesAnalyzeCodeWithAI',
            })
            .addTags([
                ...this.buildTags(provider, 'primary'),
                ...this.buildTags(fallbackProvider, 'fallback'),
            ])
            .setRunName('guardianKodyRulesAnalyzeCodeWithAI');

        if (callbacks?.length) {
            builder.addCallbacks(callbacks);
        }

        return builder;
    }

    private getGenerator(
        promptRunner: BYOKPromptRunnerService,
        provider: LLMModelProvider,
        fallbackProvider: LLMModelProvider,
        context: KodyRulesExtendedContext,
        byokConfig?: BYOKConfig,
        callbacks?: any[],
    ) {
        const builder = promptRunner
            .builder()
            .setParser(ParserType.ZOD, kodyRulesGeneratorSchema, {
                provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
            })
            .setLLMJsonMode(true)
            .setTemperature(0)
            .setPayload(context)
            .addPrompt({
                prompt: prompt_kodyrules_suggestiongeneration_system,
                role: PromptRole.SYSTEM,
            })
            .addPrompt({
                prompt: prompt_kodyrules_suggestiongeneration_user,
                role: PromptRole.USER,
            })
            .addMetadata({
                organizationId:
                    context?.organizationAndTeamData?.organizationId,
                teamId: context?.organizationAndTeamData?.teamId,
                pullRequestId: context?.pullRequest?.number,
                provider: byokConfig?.main?.provider || provider,
                fallbackProvider:
                    byokConfig?.fallback?.provider || fallbackProvider,
                model: byokConfig?.main?.model,
                fallbackModel: byokConfig?.fallback?.model,
                runName: 'suggestionGenerationKodyRulesAnalyzeCodeWithAI',
            })
            .addTags([
                ...this.buildTags(provider, 'primary'),
                ...this.buildTags(fallbackProvider, 'fallback'),
            ])
            .setRunName('suggestionGenerationKodyRulesAnalyzeCodeWithAI');

        if (callbacks?.length) {
            builder.addCallbacks(callbacks);
        }

        return builder;
    }

    private addSeverityToSuggestions(
        suggestions: AIAnalysisResult,
        kodyRules: Array<Partial<IKodyRule>>,
    ): AIAnalysisResult {
        if (!suggestions?.codeSuggestions?.length || !kodyRules?.length) {
            return suggestions;
        }

        const updatedSuggestions = suggestions.codeSuggestions.map(
            (suggestion: CodeSuggestion & { brokenKodyRulesIds: string[] }) => {
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
            // ✨ MODIFICAÇÃO: só passa severityLevelFilter se deve aplicar filtros
            severityLevelFilter: this.shouldPassSeverityFilter(
                context?.codeReviewConfig?.suggestionControl,
            )
                ? context?.codeReviewConfig?.suggestionControl
                      ?.severityLevelFilter
                : undefined,
            organizationAndTeamData: context?.organizationAndTeamData,
            kodyRules: kodyRulesFiltered,
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
        };

        return baseContext;
    }

    /**
     * ✨ SIMPLIFICADO: Determina se deve passar severityLevelFilter para análise de Kody Rules
     */
    private shouldPassSeverityFilter(
        suggestionControl?: SuggestionControlConfig,
    ): boolean {
        if (!suggestionControl) {
            return false;
        }

        // Retorna true apenas se filtros estão explicitamente habilitados para Kody Rules
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
        provider: LLMModelProvider,
        extendedContext: KodyRulesExtendedContext,
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

    private buildTags(
        provider: LLMModelProvider,
        tier: 'primary' | 'fallback',
    ) {
        return [`model:${provider}`, `tier:${tier}`, 'kodyRules'];
    }

    private async logTokenUsage(metadata: any) {
        // Log token usage para análise e monitoramento
        this.logger.log({
            message: 'Token usage',
            context: KodyRulesAnalysisService.name,
            metadata: {
                ...metadata,
            },
        });
    }
}
