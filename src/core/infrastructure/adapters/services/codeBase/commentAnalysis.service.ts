import { Inject, Injectable } from '@nestjs/common';
import {
    AlignmentLevel,
    CategorizedComment,
    UncategorizedComment,
    CommentFrequency,
} from './types/commentAnalysis.type';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { PinoLoggerService } from '../logger/pino.service';
import {
    prompt_CommentCategorizerSystem,
    prompt_CommentCategorizerUser,
    prompt_CommentIrrelevanceFilterSystem,
    prompt_CommentIrrelevanceFilterUser,
} from '@/shared/utils/langchainCommon/prompts/commentAnalysis';
import {
    IKodyRule,
    KodyRulesOrigin,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import {
    prompt_KodyRulesGeneratorDuplicateFilterSystem,
    prompt_KodyRulesGeneratorDuplicateFilterUser,
    prompt_KodyRulesGeneratorQualityFilterSystem,
    prompt_KodyRulesGeneratorQualityFilterUser,
    prompt_KodyRulesGeneratorSystem,
    prompt_KodyRulesGeneratorUser,
} from '@/shared/utils/langchainCommon/prompts/kodyRulesGenerator';
import {
    CodeReviewConfig,
    ReviewOptions,
} from '@/config/types/general/codeReview.type';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import * as filteredLibraryKodyRules from './data/filtered-rules.json';
import { KodyRuleSeverity } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@/core/domain/codeBase/contracts/CodeBaseConfigService.contract';
import { PromptRunnerService } from './promptRunner.service';
import { v4 } from 'uuid';
import { SUPPORTED_LANGUAGES } from '@/core/domain/codeBase/contracts/SupportedLanguages';

@Injectable()
export class CommentAnalysisService {
    constructor(
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,

        private readonly logger: PinoLoggerService,
        private readonly promptRunnerService: PromptRunnerService,
    ) {}

    async categorizeComments(params: {
        comments: UncategorizedComment[];
    }): Promise<CategorizedComment[]> {
        try {
            const { comments } = params;

            const filteredComments = await this.filterComments({ comments });

            if (!filteredComments || filteredComments.length === 0) {
                this.logger.log({
                    message: 'No comments after filtering',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const categorizedComments =
                await this.promptRunnerService.runPrompt({
                    payload: {
                        comments: filteredComments,
                    },
                    provider: LLMModelProvider.GEMINI_2_0_FLASH,
                    fallbackProvider: LLMModelProvider.DEEPSEEK_V3,
                    systemPromptFn: prompt_CommentCategorizerSystem,
                    userPromptFn: prompt_CommentCategorizerUser,
                    runName: 'commentCategorizer',
                });

            if (!categorizedComments || categorizedComments.length === 0) {
                this.logger.log({
                    message: 'No comments after categorization',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            return this.addBodyToCategorizedComment({
                oldComments: comments,
                newComments: categorizedComments,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error categorizing comments',
                context: CommentAnalysisService.name,
                error,
                metadata: params,
            });
        }
    }

    private addBodyToCategorizedComment(params: {
        oldComments: UncategorizedComment[];
        newComments: CategorizedComment[];
    }) {
        try {
            const { oldComments, newComments } = params;

            return newComments.map((newComment) => {
                const oldComment = oldComments.find(
                    (comment) =>
                        comment.id.toString() === newComment.id.toString(),
                );

                return {
                    ...newComment,
                    body: oldComment.body,
                };
            });
        } catch (error) {
            this.logger.error({
                message: 'Error adding body to categorized comments',
                context: CommentAnalysisService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    async generateKodyRules(params: {
        comments: UncategorizedComment[];
        existingRules: IKodyRule[];
    }): Promise<IKodyRule[]> {
        try {
            const { comments, existingRules } = params;

            const filteredComments = await this.filterComments({ comments });

            if (!filteredComments || filteredComments.length === 0) {
                this.logger.log({
                    message:
                        'No comments to generate Kody rules after filtering',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const generated = await this.promptRunnerService.runPrompt({
                payload: {
                    comments: filteredComments,
                    rules: filteredLibraryKodyRules,
                },
                provider: LLMModelProvider.GEMINI_2_0_FLASH,
                fallbackProvider: LLMModelProvider.DEEPSEEK_V3,
                systemPromptFn: prompt_KodyRulesGeneratorSystem,
                userPromptFn: prompt_KodyRulesGeneratorUser,
                runName: 'kodyRulesGenerator',
            });

            if (!generated || generated.length === 0) {
                this.logger.log({
                    message: 'No rules generated',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const genereatedWithUuids = generated.map((rule) => ({
                ...rule,
                uuid: rule.uuid || v4(),
            }));

            let deduplicatedRules = genereatedWithUuids;
            if (existingRules && existingRules.length > 0) {
                const deduplicatedRulesUuids =
                    await this.promptRunnerService.runPrompt({
                        payload: {
                            existingRules,
                            newRules: genereatedWithUuids,
                        },
                        provider: LLMModelProvider.GEMINI_2_0_FLASH,
                        fallbackProvider: LLMModelProvider.DEEPSEEK_V3,
                        systemPromptFn:
                            prompt_KodyRulesGeneratorDuplicateFilterSystem,
                        userPromptFn:
                            prompt_KodyRulesGeneratorDuplicateFilterUser,
                        runName: 'kodyRulesGeneratorDuplicateFilter',
                    });

                if (
                    !deduplicatedRulesUuids ||
                    deduplicatedRulesUuids.length === 0
                ) {
                    this.logger.log({
                        message: 'No rules after deduplication',
                        context: CommentAnalysisService.name,
                        metadata: params,
                    });
                    return [];
                }

                deduplicatedRules = this.mapRuleUuidToRule({
                    rules: genereatedWithUuids,
                    uuids: deduplicatedRulesUuids,
                });
            }

            const filteredRulesUuids = await this.promptRunnerService.runPrompt(
                {
                    payload: {
                        rules: deduplicatedRules,
                    },
                    provider: LLMModelProvider.GEMINI_2_0_FLASH,
                    fallbackProvider: LLMModelProvider.DEEPSEEK_V3,
                    systemPromptFn:
                        prompt_KodyRulesGeneratorQualityFilterSystem,
                    userPromptFn: prompt_KodyRulesGeneratorQualityFilterUser,
                    runName: 'kodyRulesGeneratorQualityFilter',
                },
            );

            if (!filteredRulesUuids || filteredRulesUuids.length === 0) {
                this.logger.log({
                    message: 'No rules after quality filter',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const filteredRules = this.mapRuleUuidToRule({
                rules: deduplicatedRules,
                uuids: filteredRulesUuids,
            });

            return this.standardizeRules({ rules: filteredRules });
        } catch (error) {
            this.logger.error({
                message: 'Error generating Kody rules',
                context: CommentAnalysisService.name,
                error,
                metadata: params,
            });
        }
    }

    private mapRuleUuidToRule(params: {
        rules: Partial<IKodyRule>[];
        uuids: string[];
    }) {
        const { rules, uuids } = params;

        return rules.filter((rule) => uuids.includes(rule.uuid));
    }

    private standardizeRules(params: {
        rules: Partial<IKodyRule>[];
    }): IKodyRule[] {
        try {
            const { rules } = params;

            const filteredKodyRulesUuids = new Set(
                filteredLibraryKodyRules.map((rule) => rule.uuid),
            );

            const standardizedRules = rules.map((rule) => {
                if (!filteredKodyRulesUuids.has(rule.uuid)) {
                    rule.uuid = '';
                }
                return rule;
            });

            return standardizedRules.map((rule) => ({
                uuid: rule.uuid || '',
                title: rule.title || '',
                rule: rule.rule || '',
                severity: rule.severity || KodyRuleSeverity.LOW,
                examples: rule.examples || [],
                origin: rule.uuid
                    ? KodyRulesOrigin.LIBRARY
                    : KodyRulesOrigin.GENERATED,
                repositoryId: 'global',
                status: KodyRulesStatus.PENDING,
            }));
        } catch (error) {
            this.logger.error({
                message: 'Error standardizing rules',
                context: CommentAnalysisService.name,
                error,
                metadata: params,
            });
            return [];
        }
    }

    private async filterComments(params: {
        comments: UncategorizedComment[];
    }): Promise<UncategorizedComment[]> {
        try {
            const { comments } = params;

            const filteredCommentsIds =
                await this.promptRunnerService.runPrompt({
                    payload: params,
                    provider: LLMModelProvider.GEMINI_2_0_FLASH,
                    fallbackProvider: LLMModelProvider.DEEPSEEK_V3,
                    systemPromptFn: prompt_CommentIrrelevanceFilterSystem,
                    userPromptFn: prompt_CommentIrrelevanceFilterUser,
                    runName: 'commentIrrelevanceFilter',
                });

            if (!filteredCommentsIds || filteredCommentsIds.length === 0) {
                throw new Error('No comments after filtering');
            }

            return comments.filter((comment) =>
                filteredCommentsIds.includes(comment.id.toString()),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error filtering comments',
                context: CommentAnalysisService.name,
                error,
                metadata: params,
            });
        }
    }

    async generateCodeReviewParameters(params: {
        comments: CategorizedComment[];
        alignmentLevel?: AlignmentLevel;
    }): Promise<Partial<CodeReviewConfig>> {
        try {
            const { comments, alignmentLevel } = params;

            const frequency = this.parameterFrequencyAnalysis(comments);

            let thresholds = this.getThresholds({
                alignmentLevel,
                values: Object.values(frequency.categories),
            });
            // activate categories that have a frequency inside the threshold
            const categories = Object.fromEntries(
                Object.entries(frequency.categories).map(([key, value]) => [
                    key,
                    value >= thresholds.lowerThreshold &&
                        value <= thresholds.upperThreshold,
                ]),
            ) as { [key in keyof ReviewOptions]: boolean };
            categories.kody_rules = true;
            categories.breaking_changes = true;

            const severityLevels: SeverityLevel[] = [
                SeverityLevel.LOW,
                SeverityLevel.MEDIUM,
                SeverityLevel.HIGH,
                SeverityLevel.CRITICAL,
            ];

            thresholds = this.getThresholds({
                alignmentLevel,
                values: Object.values(frequency.severity),
            });
            // traverses the severity levels in order of importance and returns the first one that has a frequency inside the threshold
            const severity =
                severityLevels.find((level) => {
                    return (
                        frequency.severity[level] >=
                            thresholds.lowerThreshold &&
                        frequency.severity[level] <= thresholds.upperThreshold
                    );
                }) || SeverityLevel.HIGH;

            const defaultConfig =
                await this.codeBaseConfigService.getDefaultConfigs();

            const generatedConfig: CodeReviewConfig = {
                ...defaultConfig,
                reviewOptions: categories,
                suggestionControl: {
                    ...defaultConfig.suggestionControl,
                    severityLevelFilter: SeverityLevel.HIGH,
                },
                kodyRulesGeneratorEnabled: true,
            };

            return generatedConfig;
        } catch (error) {
            this.logger.error({
                message: 'Error generating code review parameter',
                context: CommentAnalysisService.name,
                error,
                metadata: params,
            });
            return null;
        }
    }

    private getThresholds(params: {
        alignmentLevel?: AlignmentLevel;
        values: number[];
    }) {
        const { alignmentLevel, values } = params;

        if (!values || values.length === 0) {
            return {
                lowerThreshold: 0,
                upperThreshold: 1,
            };
        }

        // get the lower and upper bounds of the values with a slight buffer
        const LOWER = Math.max(0, Math.min(...values) - 0.1);
        const UPPER = Math.min(1, Math.max(...values) + 0.1);

        // change mid weight to increase/decrease the skew
        // 0.25 skewed towards lower threshold
        // 0.5 balanced, aka mean average
        // 0.75 skewed towards upper threshold
        const MID = this.interpolation(LOWER, UPPER, 0.25);

        let weight: number;
        switch (alignmentLevel) {
            // opposite of reference reviews, skews towards lower threshold
            case AlignmentLevel.LOW:
                weight = 0;
                break;
            // middle ground, balanced
            case AlignmentLevel.MEDIUM:
                weight = 0.5;
                break;
            // aligns with reference reviews, skews towards upper threshold
            case AlignmentLevel.HIGH:
                weight = 1;
                break;
            default:
                weight = 1;
        }

        const lowerThreshold = this.interpolation(LOWER, MID, weight);

        // if no alignment level is provided ignore the upper threshold
        const upperThreshold = alignmentLevel
            ? this.interpolation(MID, UPPER, weight)
            : 1;

        return {
            lowerThreshold,
            upperThreshold,
        };
    }

    private interpolation(low: number, high: number, weight: number) {
        return low + (high - low) * weight;
    }

    private parameterFrequencyAnalysis(
        comments: CategorizedComment[],
    ): CommentFrequency {
        try {
            const total = comments.length;

            const count: CommentFrequency = {
                categories: {
                    breaking_changes: 0,
                    code_style: 0,
                    documentation_and_comments: 0,
                    error_handling: 0,
                    kody_rules: 0,
                    maintainability: 0,
                    performance_and_optimization: 0,
                    potential_issues: 0,
                    refactoring: 0,
                    security: 0,
                } as { [key in keyof ReviewOptions]: number },
                severity: {
                    critical: 0,
                    high: 0,
                    medium: 0,
                    low: 0,
                } as { [key in SeverityLevel]: number },
            };

            comments.forEach((comment) => {
                const { category, severity } = comment;
                count.categories[category] =
                    (count.categories[category] || 0) + 1;
                count.severity[severity] = (count.severity[severity] || 0) + 1;
            });

            const categories = this.getPercentages(count.categories, total);
            const severity = this.getPercentages(count.severity, total);

            return {
                categories,
                severity,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error analyzing frequency',
                context: CommentAnalysisService.name,
                error,
                metadata: comments,
            });
            return null;
        }
    }

    private getPercentages<T>(count: T, total: number) {
        return Object.fromEntries(
            Object.entries(count).map(([key, value]) => [
                key,
                total > 0 ? value / total : 0,
            ]),
        ) as T;
    }

    processComments(
        comments: {
            pr: any;
            generalComments: any[];
            reviewComments: any[];
            files?: any[];
        }[],
    ) {
        const processedComments = comments
            .map((pr) => {
                const allComments = [
                    ...pr.generalComments,
                    ...pr.reviewComments,
                ];

                const mappedComments = allComments.flatMap((comment) => {
                    if (!('body' in comment)) {
                        return comment.notes.flatMap((note) => ({
                            id: note.id,
                            body: note.body,
                        }));
                    }
                    return comment;
                });

                const uniqueComments = [];
                const seenIds = new Set();

                for (const comment of mappedComments) {
                    if (!seenIds.has(comment.id)) {
                        seenIds.add(comment.id);
                        uniqueComments.push(comment);
                    }
                }

                const filteredComments = uniqueComments
                    .filter(
                        (comment) =>
                            !comment.user ||
                            !comment.user.type ||
                            comment.user.type.toLowerCase() !== 'bot',
                    )
                    .filter(
                        (comment) =>
                            !comment.body
                                .toLowerCase()
                                .includes('kody-codereview'),
                    )
                    .filter((comment) => comment.body.length > 100);

                let finalComments = filteredComments;
                if (pr.files && pr.files.length > 0) {
                    const fileExtensionFrequency =
                        this.fileExtensionFrequencyAnalysis(pr.files);

                    if (!fileExtensionFrequency) {
                        return null;
                    }

                    const sortedExtensions = Object.entries(
                        fileExtensionFrequency,
                    )
                        .sort(
                            (
                                [_, a]: [string, number],
                                [__, b]: [string, number],
                            ) => b - a,
                        )
                        .map(([ext, _]) => ext);

                    const supportedLanguageConfig = Object.values(
                        SUPPORTED_LANGUAGES,
                    ).find((lang) =>
                        lang.extensions.some((ext) =>
                            sortedExtensions.includes(ext.slice(1)),
                        ),
                    );

                    if (supportedLanguageConfig) {
                        finalComments = finalComments.map((comment) => ({
                            ...comment,
                            language: supportedLanguageConfig.name,
                        }));
                    }
                }

                return {
                    pr: pr.pr,
                    comments: finalComments,
                };
            })
            .filter((pr) => pr.comments.length > 0) // Remove PRs with no comments
            .flatMap((pr) => pr.comments)
            .slice(0, 100);

        if (processedComments.length === 0) {
            this.logger.log({
                message: 'No valid comments found after processing',
                context: CommentAnalysisService.name,
            });
            return [];
        }

        if (processedComments.length < 20) {
            this.logger.log({
                message:
                    'Less than 20 valid comments found after processing, results quality may be affected',
                context: CommentAnalysisService.name,
                metadata: processedComments,
            });
        }

        return processedComments;
    }

    private fileExtensionFrequencyAnalysis(files: { filename: string }[]) {
        try {
            const total = files.length;

            const count = files.reduce((acc, file) => {
                const extension = file.filename.split('.').pop();
                acc[extension] = (acc[extension] || 0) + 1;
                return acc;
            }, {});

            return this.getPercentages(count, total);
        } catch (error) {
            this.logger.error({
                message: 'Error analyzing frequency',
                context: CommentAnalysisService.name,
                error,
                metadata: files,
            });
            return null;
        }
    }
}
