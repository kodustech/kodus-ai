import { Injectable } from '@nestjs/common';
import {
    FileChangeContext,
    AnalysisContext,
    AIAnalysisResult,
    CodeSuggestion,
    ReviewModeResponse,
    FileChange,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { RunnableSequence } from '@langchain/core/runnables';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { tryParseJSONObject } from '@/shared/utils/transforms/json';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import {
    getChatGemini,
    getChatVertexAI,
} from '@/shared/utils/langchainCommon/document';
import Anthropic from '@anthropic-ai/sdk';
import { getKodyRulesForFile } from '@/shared/utils/glob-utils';
import {
    prompt_kodyrules_classifier_system,
    prompt_kodyrules_classifier_user,
    prompt_kodyrules_suggestiongeneration_system,
    prompt_kodyrules_suggestiongeneration_user,
    prompt_kodyrules_updatestdsuggestions_system,
    prompt_kodyrules_updatestdsuggestions_user,
} from '@/shared/utils/langchainCommon/prompts/kodyRules';
import { IKodyRule } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { IAIAnalysisService } from '@/core/domain/codeBase/contracts/AIAnalysisService.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

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

    constructor(private readonly logger: PinoLoggerService) {
        this.anthropic = new Anthropic({
            apiKey: process.env.API_ANTHROPIC_API_KEY,
        });
        this.tokenTracker = new TokenTrackingHandler();
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

        const provider = LLMModelProvider.GEMINI_1_5_PRO;
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

            return this.addSeverityToSuggestions(
                finalOutput,
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
                if (severities.length > 0) {
                    return {
                        ...suggestion,
                        severity: severities[0],
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
            severityLevelFilter:
                context?.codeReviewConfig?.suggestionControl
                    ?.severityLevelFilter,
            organizationAndTeamData: context?.organizationAndTeamData,
            kodyRules: kodyRulesFiltered,
        };

        return baseContext;
    }

    private async createAnalysisChainWithFallback(
        provider: LLMModelProvider,
        context: any,
        systemPromptFn: SystemPromptFn,
        userPromptFn: UserPromptFn,
        runName?: string,
    ) {
        const fallbackProvider =
            provider === LLMModelProvider.GEMINI_1_5_PRO
                ? LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET
                : LLMModelProvider.GEMINI_1_5_PRO;
        try {
            const mainChain = await this.createProviderChain(
                provider,
                context,
                systemPromptFn,
                userPromptFn,
            );
            const fallbackChain = await this.createProviderChain(
                fallbackProvider,
                context,
                systemPromptFn,
                userPromptFn,
            );

            // Used withFallbacks to configure the fallback correctly
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName,
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                        provider: provider,
                        fallbackProvider: fallbackProvider,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: KodyRulesAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
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
    ) {
        try {
            let llm =
                provider === LLMModelProvider.GEMINI_1_5_PRO
                    ? getChatGemini({
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      })
                    : getChatVertexAI({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.VERTEX_CLAUDE_3_5_SONNET,
                          ),
                          temperature: 0,
                          callbacks: [this.tokenTracker],
                      });

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
            ]);

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

            let parsedResponse = tryParseJSONObject(cleanResponse);

            if (!parsedResponse) {
                this.logger.error({
                    message: 'Failed to parse classifier response',
                    context: KodyRulesAnalysisService.name,
                    metadata: {
                        originalResponse: response,
                        cleanResponse,
                    },
                });
                return null;
            }

            const filteredRules = allRules.filter((rule) =>
                parsedResponse.some(
                    (responseRule) => responseRule.uuid === rule.uuid,
                ),
            );

            return filteredRules;
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

    private processLLMResponse(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        response: string,
        fileContext: FileChangeContext,
        provider: LLMModelProvider,
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

            parsedResponse.codeSuggestions =
                parsedResponse?.codeSuggestions?.map((suggestion) => {
                    if (suggestion.label) {
                        return suggestion;
                    }

                    return {
                        ...suggestion,
                        label: 'kody_rules',
                    };
                });

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

    async createSeverityAnalysisChain(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        provider: LLMModelProvider,
        codeSuggestions: any[],
        selectedCategories: object,
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

    specificCategoriesCodeReview(
        organizationAndTeamData: any,
        prNumber: any,
        fileContext: any,
        reviewModeResponse: any,
        context: any,
    ): Promise<AIAnalysisResult[]> {
        throw new Error('Method not implemented.');
    }
}
