import { Inject, Injectable } from '@nestjs/common';
import {
    FileChangeContext,
    AnalysisContext,
    AIAnalysisResult,
    CodeSuggestion,
    ReviewModeResponse,
    FileChange,
    ReviewOptions,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { tryParseJSONObject } from '@/shared/utils/transforms/json';
import { LLMModelProvider } from '@/core/infrastructure/adapters/services/llmProviders/llmModelProvider.helper';
import Anthropic from '@anthropic-ai/sdk';
import { getKodyRulesForFile } from '@/shared/utils/glob-utils';
import {
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
import { IKodyRule } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { IAIAnalysisService } from '@/core/domain/codeBase/contracts/AIAnalysisService.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import { LLMProviderService } from '@/core/infrastructure/adapters/services/llmProviders/llmProvider.service';
import { LLM_PROVIDER_SERVICE_TOKEN } from '@/core/infrastructure/adapters/services/llmProviders/llmProvider.service.contract';
import { KodyRulesService } from '../kodyRules/service/kodyRules.service';
import { KODY_RULES_SERVICE_TOKEN } from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import { string } from 'joi';
import { REPOSITORY_MANAGER_TOKEN, IRepositoryManager } from '@/core/domain/repository/contracts/repository-manager.contract';

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

export const KODY_RULES_ANALYSIS_SERVICE_TOKEN = Symbol(
    'KodyRulesAnalysisService',
);

type SystemPromptFn = () => string;
type UserPromptFn = (input: any) => string;

@Injectable()
export class KodyRulesAnalysisService implements IAIAnalysisService {
    private readonly anthropic: Anthropic;
    private readonly tokenTracker: TokenTrackingHandler;

    @Inject(KODY_RULES_SERVICE_TOKEN)
    private readonly kodyRulesService: KodyRulesService;
    /**
     * Process the LLM response about violation decisions
     * @param organizationAndTeamData Organization and team data
     * @param prNumber Pull request number
     * @param response String containing the LLM response
     * @returns Map with the violation ID and if it should be removed or not, or null in case of error
     */
    private processViolationDecisions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        response: string,
    ): Map<string, boolean> | null {
        try {
            const cleanResponse = response.replace(/```json\n|```/g, '');
            const parsedResponse = tryParseJSONObject(cleanResponse);

            if (!parsedResponse?.decisions) {
                this.logger.error({
                    message: 'Failed to parse violation decisions response',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        originalResponse: response,
                        cleanResponse,
                        prNumber,
                    },
                });
                return null;
            }

            return new Map(
                parsedResponse?.decisions?.map((decision) => [
                    decision.id,
                    decision.shouldRemove,
                ]),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error processing violation decisions',
                context: KodyRulesAnalysisService.name,
                error,
                metadata: { organizationAndTeamData, prNumber, response },
            });
            return null;
        }
    }

    constructor(
        private readonly logger: PinoLoggerService,
        @Inject(LLM_PROVIDER_SERVICE_TOKEN)
        private readonly llmProviderService: LLMProviderService,
        @Inject(REPOSITORY_MANAGER_TOKEN)
        private readonly repositoryManager: IRepositoryManager,
    ) {
        this.anthropic = new Anthropic({
            apiKey: process.env.API_ANTHROPIC_API_KEY,
        });
        this.tokenTracker = new TokenTrackingHandler();
    }

    private async buildKodyRuleLinkAndRepalceIds(
        foundIds: string[],
        updatedContent: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<string> {
        // Processar todos os IDs encontrados
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
    ): Promise<AIAnalysisResult> {
        if (!suggestions?.codeSuggestions?.length) {
            return suggestions;
        }

        const updatedSuggestions = await Promise.all(
            suggestions.codeSuggestions.map(async (suggestion) => {
                try {
                    let updatedContent = suggestion?.suggestionContent || '';

                    const uuidRegex =
                        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
                    let foundIds: string[] =
                        updatedContent.match(uuidRegex) || [];

                    if (!foundIds?.length) {
                        let extractedIds: string[] = [];

                        if (suggestion?.suggestionContent) {
                            extractedIds =
                                await this.extractKodyRuleIdsFromContent(
                                    updatedContent,
                                    organizationAndTeamData,
                                    prNumber,
                                    suggestion,
                                );
                        }

                        if (extractedIds.length > 0) {
                            foundIds = extractedIds;
                        } else {
                            const brokenIds = (suggestion as any)
                                ?.brokenKodyRulesIds;
                            if (brokenIds?.length > 0) {
                                const firstRuleId = brokenIds[0];
                                updatedContent += `\n\nKody Rules Violation: ${firstRuleId}`;
                                foundIds = [firstRuleId];
                            } else {
                                return suggestion;
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
    ): Promise<string[]> {
        try {
            const extractionChain = await this.createAnalysisChainWithFallback(
                LLMModelProvider.GEMINI_2_5_FLASH_PREVIEW_05_20,
                { suggestionContent: updatedContent },
                prompt_kodyrules_extract_id_system,
                prompt_kodyrules_extract_id_user,
                'extractKodyRuleIdsFromContent',
                LLMModelProvider.GEMINI_2_5_PRO_PREVIEW_05_06,
            );

            const extractionResult = await extractionChain.invoke({
                suggestionContent: updatedContent,
            });

            if (extractionResult) {
                const cleanResponse = extractionResult.replace(
                    /```json\n|```/g,
                    '',
                );
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

        const provider = LLMModelProvider.GEMINI_2_5_PRO_PREVIEW_05_06;
        // Reset token tracking for new analysis
        this.tokenTracker.reset();

        // Prepare base context
        const baseContext = await this.prepareAnalysisContext(
            fileContext,
            context,
        );

        // Verify if there are Kody Rules applicable for this file
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

            return {
                codeSuggestions: [],
                overallSummary: '',
            };
        }

        let extendedContext = {
            ...baseContext,
            standardSuggestions: hasCodeSuggestions ? suggestions : undefined,
            updatedSuggestions: undefined,
            filteredKodyRules: undefined,
        };

        try {
            // Create all the chains needed for the analysis
            const [
                classifiedKodyRulesChain,
                updateStandardSuggestionsChain,
                generateKodyRulesSuggestionsChain,
                guardianKodyRulesChain,
            ] = await Promise.all([
                this.createAnalysisChainWithFallback(
                    provider,
                    baseContext,
                    prompt_kodyrules_classifier_system,
                    prompt_kodyrules_classifier_user,
                    'classifierKodyRulesAnalyzeCodeWithAI',
                ),
                this.createAnalysisChainWithFallback(
                    provider,
                    baseContext,
                    prompt_kodyrules_updatestdsuggestions_system,
                    prompt_kodyrules_updatestdsuggestions_user,
                    'updateStandardSuggestionsAnalyzeCodeWithAI',
                ),
                this.createAnalysisChainWithFallback(
                    provider,
                    baseContext,
                    prompt_kodyrules_suggestiongeneration_system,
                    prompt_kodyrules_suggestiongeneration_user,
                    'generateKodyRulesSuggestionsAnalyzeCodeWithAI',
                ),
                this.createAnalysisChainWithFallback(
                    provider,
                    baseContext,
                    prompt_kodyrules_guardian_system,
                    prompt_kodyrules_guardian_user,
                    'guardianKodyRulesAnalyzeCodeWithAI',
                ),
            ]);

            // These chains do not depend on each other, so we can run them in parallel
            const [classifiedRulesResult, updateStandardSuggestionsResult] =
                await Promise.all([
                    classifiedKodyRulesChain.invoke(baseContext),
                    hasCodeSuggestions
                        ? updateStandardSuggestionsChain?.invoke(
                              extendedContext,
                          )
                        : Promise.resolve(undefined),
                ]);

            const classifiedRules = this.processClassifierResponse(
                baseContext.kodyRules,
                classifiedRulesResult,
            );

            const updatedSuggestions = this.processLLMResponse(
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

                return {
                    codeSuggestions: [],
                    overallSummary: '',
                };
            }

            extendedContext = {
                ...extendedContext,
                filteredKodyRules: classifiedRules,
                updatedSuggestions: updatedSuggestions
                    ? updatedSuggestions
                    : undefined,
            };

            const generatedKodyRulesSuggestionsResult =
                await generateKodyRulesSuggestionsChain.invoke(extendedContext);

            const generatedKodyRulesSuggestions = this.processLLMResponse(
                organizationAndTeamData,
                prNumber,
                generatedKodyRulesSuggestionsResult,
                fileContext,
                provider,
                extendedContext,
            );

            let finalOutput = {
                codeSuggestions: [
                    ...generatedKodyRulesSuggestions?.codeSuggestions,
                ],
                overallSummary:
                    updatedSuggestions?.overallSummary ||
                    generatedKodyRulesSuggestions?.overallSummary ||
                    '',
            };

            if (updatedSuggestions) {
                finalOutput.codeSuggestions = [
                    ...finalOutput.codeSuggestions,
                    ...updatedSuggestions?.codeSuggestions,
                ];
            }

            const finalOutputWithLinks = await this.replaceKodyRuleIdsWithLinks(
                finalOutput,
                organizationAndTeamData,
                prNumber,
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
        const kodyRulesFiltered = getKodyRulesForFile(
            fileContext.file.filename,
            context?.codeReviewConfig?.kodyRules || [],
        )?.map((rule) => ({
            uuid: rule?.uuid,
            rule: rule?.rule,
            severity: rule?.severity,
            examples: rule?.examples ?? [],
            contextPaths: rule?.contextPaths ?? [],
        }));

        const contextPaths = new Set<string>();
        kodyRulesFiltered?.forEach((rule) => {
            rule.contextPaths?.forEach((p) => contextPaths.add(p));
        });

        let contextFilesContent = '';
        for (const p of contextPaths) {
            try {
                const content = await this.repositoryManager.readFileContent(
                    context.organizationAndTeamData.organizationId,
                    context.repository.id,
                    context.repository.name,
                    p,
                    context.repository.defaultBranch,
                );
                contextFilesContent += `\n// ${p}\n${content}`;
            } catch {}
        }

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
            severityLevelFilter:
                context?.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter,
            organizationAndTeamData: context?.organizationAndTeamData,
            kodyRules: kodyRulesFiltered,
            contextFilesContent,
        };

        return baseContext;
    }

    private async createAnalysisChainWithFallback(
        provider: LLMModelProvider,
        context: any,
        systemPromptFn: SystemPromptFn,
        userPromptFn: UserPromptFn,
        runName?: string,
        fallbackProvider?: LLMModelProvider,
    ) {
        let fallbackProviderToExecute = fallbackProvider;

        if (!fallbackProvider) {
            fallbackProviderToExecute =
                provider === LLMModelProvider.GEMINI_2_5_PRO_PREVIEW_05_06
                    ? LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET
                    : LLMModelProvider.GEMINI_2_5_PRO_PREVIEW_05_06;
        }

        try {
            const mainChain = await this.createProviderChain(
                provider,
                context,
                systemPromptFn,
                userPromptFn,
                'primary',
            );
            const fallbackChain = await this.createProviderChain(
                fallbackProviderToExecute,
                context,
                systemPromptFn,
                userPromptFn,
                'fallback',
            );

            // Used withFallbacks to configure the fallback correctly
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    tags: this.buildTags(provider, 'primary'),
                    runName,
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProviderToExecute,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: KodyRulesAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider: fallbackProviderToExecute,
                },
            });
            throw error;
        }
    }

    private async createProviderChain(
        provider: LLMModelProvider,
        context: any,
        systemPromptFn: SystemPromptFn,
        userPromptFn: UserPromptFn,
        tier: 'primary' | 'fallback',
    ) {
        try {
            let llm = this.llmProviderService.getLLMProvider({
                model: provider,
                temperature: 0,
                jsonMode: true,
                callbacks: [this.tokenTracker],
            });

            const tags = this.buildTags(provider, 'primary');

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
            ]).withConfig({ tags });

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating provider chain',
                error,
                context: KodyRulesAnalysisService.name,
                metadata: { provider },
            });
            throw error;
        }
    }

    private processClassifierResponse(
        allRules: Array<Partial<IKodyRule> | IKodyRule>,
        response: string,
    ): Array<Partial<IKodyRule> | IKodyRule> | null {
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

            const parsedResponse = tryParseJSONObject(cleanResponse);

            if (!parsedResponse?.length) {
                this.logger.warn({
                    message:
                        'Failed to parse classifier response OR not response',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        originalResponse: response,
                        cleanResponse,
                    },
                });
                return null;
            }

            const responseMap = new Map(
                parsedResponse.map((rule) => [rule.uuid, rule.reason]),
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
        response: string,
        fileContext: FileChangeContext,
        provider: LLMModelProvider,
        extendedContext: any,
    ): AIAnalysisResult | null {
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

            let parsedResponse = tryParseJSONObject(cleanResponse);

            if (!parsedResponse) {
                this.logger.error({
                    message: 'Failed to parse LLM response',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        originalResponse: response,
                        cleanResponse,
                        prNumber,
                    },
                });
                return null;
            }

            // Normalize the types of fields that may come as strings
            if (parsedResponse?.codeSuggestions) {
                parsedResponse.codeSuggestions =
                    parsedResponse.codeSuggestions.map((suggestion) => ({
                        ...suggestion,
                        relevantLinesStart:
                            Number(suggestion.relevantLinesStart) || undefined,
                        relevantLinesEnd:
                            Number(suggestion.relevantLinesEnd) || undefined,
                    }));
            }

            if (parsedResponse?.codeSuggestions) {
                parsedResponse.codeSuggestions =
                    parsedResponse.codeSuggestions.map((suggestion) => {
                        if (!suggestion?.id || !uuidValidate(suggestion?.id)) {
                            return {
                                ...suggestion,
                                id: uuidv4(),
                            };
                        }
                        return suggestion;
                    });

                if (extendedContext?.reviewOptions) {
                    parsedResponse.codeSuggestions =
                        this.processSuggestionLabels(
                            parsedResponse.codeSuggestions,
                            extendedContext.reviewOptions,
                        );
                } else {
                    parsedResponse.codeSuggestions =
                        parsedResponse.codeSuggestions.map((suggestion) => ({
                            ...suggestion,
                            label: suggestion.label ?? 'kody_rules',
                        }));
                }
            }

            this.logTokenUsage({
                tokenUsages: parsedResponse.codeSuggestions,
                pullRequestId: prNumber,
                fileContext: fileContext?.file?.filename,
                provider,
                organizationAndTeamData,
            });

            return {
                codeSuggestions: parsedResponse.codeSuggestions || [],
                overallSummary: parsedResponse.overallSummary || '',
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

    createSeverityAnalysisChainWithFallback(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: CodeSuggestion[],
    ): Promise<any> {
        throw new Error('Method not implemented.');
    }

    async extractSuggestionsFromCodeReviewSafeguard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        safeGuardResponse: any,
    ): Promise<any> {
        throw new Error('Method not implemented.');
    }

    async filterSuggestionsSafeGuard(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        file: any,
        codeDiff: string,
        suggestions: any[],
        languageResultPrompt: string,
    ): Promise<any> {
        throw new Error('Method not implemented.');
    }

    async generateCodeSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        sessionId: string,
        question: string,
        parameters: any,
    ) {
        throw new Error('Method not implemented.');
    }

    validateImplementedSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codePatch: any,
        codeSuggestions: Partial<CodeSuggestion>[],
    ): Promise<any> {
        throw new Error('Method not implemented.');
    }

    selectReviewMode(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        file: FileChange,
        codeDiff: string,
    ): Promise<ReviewModeResponse> {
        throw new Error('Method not implemented.');
    }

    severityAnalysisAssignment(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: CodeSuggestion[],
    ): Promise<CodeSuggestion[]> {
        throw new Error('Method not implemented.');
    }
}
