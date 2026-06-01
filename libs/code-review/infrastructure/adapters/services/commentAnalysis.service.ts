import { createLogger } from '@kodus/flow';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import filteredLibraryKodyRules from '@libs/code-review/infrastructure/data/filtered-rules.json';
import { Injectable } from '@nestjs/common';
import { v4 } from 'uuid';

import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';
import { isKodyAuthoredBody } from '@libs/common/utils/kody-identifiers';
import {
    CategorizedComment,
    UncategorizedComment,
} from '@libs/code-review/domain/types/commentAnalysis.type';
import {
    commentCategorizerSchema,
    commentIrrelevanceFilterSchema,
    prompt_CommentCategorizerSystem,
    prompt_CommentCategorizerUser,
    prompt_CommentIrrelevanceFilterSystem,
    prompt_CommentIrrelevanceFilterUser,
} from '@libs/common/utils/langchainCommon/prompts/commentAnalysis';
import {
    kodyRulesGeneratorDuplicateFilterSchema,
    kodyRulesGeneratorQualityFilterSchema,
    kodyRulesGeneratorSchema,
    prompt_KodyRulesGeneratorDuplicateFilterSystem,
    prompt_KodyRulesGeneratorDuplicateFilterUser,
    prompt_KodyRulesGeneratorQualityFilterSystem,
    prompt_KodyRulesGeneratorQualityFilterUser,
    prompt_KodyRulesGeneratorSystem,
    prompt_KodyRulesGeneratorUser,
} from '@libs/common/utils/langchainCommon/prompts/kodyRulesGenerator';
import { DocumentationContextItem } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { LibraryKodyRule } from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IKodyRule,
    KodyRulesOrigin,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

@Injectable()
export class CommentAnalysisService {
    private readonly logger = createLogger(CommentAnalysisService.name);
    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
        private readonly permissionValidationService: PermissionValidationService,
    ) {}

    async categorizeComments(params: {
        comments: UncategorizedComment[];
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<CategorizedComment[]> {
        const { comments, organizationAndTeamData } = params;

        try {
            const filteredComments = await this.filterComments({
                comments,
                organizationAndTeamData,
            });
            if (!filteredComments || filteredComments.length === 0) {
                this.logger.log({
                    message: 'No comments after filtering',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const runName = 'commentCategorizer';
            const spanName = `${CommentAnalysisService.name}::${runName}`;

            const byokConfig =
                await this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                );

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                LLMModelProvider.GEMINI_2_5_PRO,
                LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
                byokConfig,
            );

            const spanAttrs = {
                type: promptRunner.executeMode,
                commentsCount: filteredComments.length,
            };

            const { result: categorizedCommentsRes } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    byokConfig,
                    exec: async (callbacks) => {
                        return promptRunner
                            .builder()
                            .setParser(ParserType.ZOD, commentCategorizerSchema)
                            .setLLMJsonMode(true)
                            .setPayload({ comments: filteredComments })
                            .addPrompt({
                                role: PromptRole.SYSTEM,
                                prompt: prompt_CommentCategorizerSystem,
                            })
                            .addPrompt({
                                role: PromptRole.USER,
                                prompt: prompt_CommentCategorizerUser,
                            })
                            .addMetadata({
                                context: CommentAnalysisService.name,
                                metadata: params,
                                runName,
                            })
                            .addCallbacks(callbacks)
                            .setRunName(runName)
                            .execute();
                    },
                });

            const categorizedComments = categorizedCommentsRes?.suggestions;
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
        newComments: Partial<CategorizedComment>[];
    }): CategorizedComment[] {
        try {
            const { oldComments, newComments } = params;

            return newComments.map((newComment) => {
                const oldComment = oldComments.find(
                    (comment) =>
                        comment.id.toString() === newComment.id.toString(),
                );

                return {
                    id: oldComment.id,
                    body: oldComment.body,
                    category: newComment.category,
                    severity: newComment.severity,
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
        organizationAndTeamData: OrganizationAndTeamData;
        memories?: Array<Partial<IKodyRule>>;
        documentationContext?: DocumentationContextItem[];
    }): Promise<IKodyRule[]> {
        const {
            comments,
            existingRules,
            organizationAndTeamData,
            memories,
            documentationContext,
        } = params;

        try {
            const filteredComments = await this.filterComments({
                comments,
                organizationAndTeamData,
            });

            if (!filteredComments || filteredComments.length === 0) {
                this.logger.log({
                    message:
                        'No comments to generate Kody rules after filtering',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const byokConfig =
                await this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                );

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                LLMModelProvider.GEMINI_2_5_PRO,
                LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
                byokConfig,
            );

            const genRun = 'generateKodyRules.generate';
            const { result: generatedRes } =
                await this.observabilityService.runLLMInSpan({
                    spanName: `${CommentAnalysisService.name}::${genRun}`,
                    runName: genRun,
                    attrs: {
                        type: promptRunner.executeMode,
                        commentsCount: filteredComments.length,
                    },
                    byokConfig,
                    exec: async (callbacks) => {
                        return promptRunner
                            .builder()
                            .setParser(ParserType.ZOD, kodyRulesGeneratorSchema)
                            .setLLMJsonMode(true)
                            .setPayload({
                                comments: filteredComments,
                                rules: filteredLibraryKodyRules,
                                memories,
                                documentationContext,
                            })
                            .addPrompt({
                                role: PromptRole.SYSTEM,
                                prompt: prompt_KodyRulesGeneratorSystem,
                            })
                            .addPrompt({
                                role: PromptRole.USER,
                                prompt: prompt_KodyRulesGeneratorUser,
                            })
                            .addMetadata({
                                context: CommentAnalysisService.name,
                                metadata: params,
                                runName: genRun,
                            })
                            .setRunName(genRun)
                            .addCallbacks(callbacks)
                            .execute();
                    },
                });

            const generated = generatedRes?.rules as Partial<IKodyRule>[];

            if (!generated || generated.length === 0) {
                this.logger.log({
                    message: 'No rules generated',
                    context: CommentAnalysisService.name,
                    metadata: params,
                });
                return [];
            }

            const generatedWithUuids = generated.map((rule) => ({
                ...rule,
                uuid: rule.uuid || v4(),
            }));

            const existingRulesAsLibrary = existingRules.map((rule) => ({
                ...rule,
                why_is_this_important:
                    (rule as Partial<LibraryKodyRule>)?.why_is_this_important ||
                    '',
            })) as LibraryKodyRule[];

            let deduplicatedRules = generatedWithUuids;
            if (existingRules && existingRules.length > 0) {
                const dedupeRun = 'generateKodyRules.dedupe';
                const { result: deduplicatedRulesUuidsRes } =
                    await this.observabilityService.runLLMInSpan({
                        spanName: `${CommentAnalysisService.name}::${dedupeRun}`,
                        runName: dedupeRun,
                        attrs: {
                            type: promptRunner.executeMode,
                            newRulesCount: generatedWithUuids.length,
                            existingRulesCount: existingRulesAsLibrary.length,
                        },
                        byokConfig,
                        exec: async (callbacks) => {
                            return promptRunner
                                .builder()
                                .setParser(
                                    ParserType.ZOD,
                                    kodyRulesGeneratorDuplicateFilterSchema,
                                )
                                .setLLMJsonMode(true)
                                .setPayload({
                                    existingRules: existingRulesAsLibrary,
                                    newRules: generatedWithUuids,
                                })
                                .addPrompt({
                                    role: PromptRole.SYSTEM,
                                    prompt: prompt_KodyRulesGeneratorDuplicateFilterSystem,
                                })
                                .addPrompt({
                                    role: PromptRole.USER,
                                    prompt: prompt_KodyRulesGeneratorDuplicateFilterUser,
                                })
                                .addMetadata({
                                    context: CommentAnalysisService.name,
                                    metadata: params,
                                    runName: dedupeRun,
                                })
                                .addCallbacks(callbacks)
                                .setRunName(dedupeRun)
                                .execute();
                        },
                    });

                const deduplicatedRulesUuids = deduplicatedRulesUuidsRes?.uuids;

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
                    rules: generatedWithUuids,
                    uuids: deduplicatedRulesUuids,
                });
            }

            const qualityRun = 'generateKodyRules.quality';
            const { result: filteredRulesUuidsRes } =
                await this.observabilityService.runLLMInSpan({
                    spanName: `${CommentAnalysisService.name}::${qualityRun}`,
                    runName: qualityRun,
                    attrs: {
                        type: promptRunner.executeMode,
                        candidateRulesCount: deduplicatedRules.length,
                    },
                    byokConfig,
                    exec: async (callbacks) => {
                        return promptRunner
                            .builder()
                            .setParser(
                                ParserType.ZOD,
                                kodyRulesGeneratorQualityFilterSchema,
                            )
                            .setLLMJsonMode(true)
                            .setPayload({ rules: deduplicatedRules })
                            .addPrompt({
                                role: PromptRole.SYSTEM,
                                prompt: prompt_KodyRulesGeneratorQualityFilterSystem,
                            })
                            .addPrompt({
                                role: PromptRole.USER,
                                prompt: prompt_KodyRulesGeneratorQualityFilterUser,
                            })
                            .addMetadata({
                                context: CommentAnalysisService.name,
                                metadata: params,
                                runName: qualityRun,
                            })
                            .addCallbacks(callbacks)
                            .setRunName(qualityRun)
                            .execute();
                    },
                });

            const filteredRulesUuids = filteredRulesUuidsRes?.uuids;

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
        rules: Array<Omit<Partial<IKodyRule>, 'uuid'> & { uuid: string }>;
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
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<UncategorizedComment[]> {
        const { comments, organizationAndTeamData } = params;

        try {
            const runName = 'commentIrrelevanceFilter';
            const spanName = `${CommentAnalysisService.name}::${runName}`;

            const byokConfig =
                await this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                );

            const promptRunner = new BYOKPromptRunnerService(
                this.promptRunnerService,
                LLMModelProvider.GEMINI_2_5_PRO,
                LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
                byokConfig,
            );

            const spanAttrs = {
                type: promptRunner.executeMode,
                commentsCount: comments.length,
            };

            const { result: filteredCommentsIdsRes } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    byokConfig,
                    exec: async (callbacks) => {
                        return promptRunner
                            .builder()
                            .setParser(
                                ParserType.ZOD,
                                commentIrrelevanceFilterSchema,
                            )
                            .setLLMJsonMode(true)
                            .setPayload({ comments })
                            .addPrompt({
                                role: PromptRole.SYSTEM,
                                prompt: prompt_CommentIrrelevanceFilterSystem,
                            })
                            .addPrompt({
                                role: PromptRole.USER,
                                prompt: prompt_CommentIrrelevanceFilterUser,
                            })
                            .addMetadata({
                                context: CommentAnalysisService.name,
                                metadata: params,
                                runName,
                            })
                            .addCallbacks(callbacks)
                            .setRunName(runName)
                            .execute();
                    },
                });

            const filteredCommentsIds = filteredCommentsIdsRes?.ids;

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

                    if (comment?.threadId) {
                        // Azure DevOps: ensure unique ID
                        return {
                            ...comment,
                            id: `${comment.threadId}-${comment.id}`, // composite ID
                        };
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
                    ?.filter(
                        (comment) =>
                            !comment?.user ||
                            !comment?.user?.type ||
                            comment?.user?.type?.toLowerCase() !== 'bot',
                    )
                    ?.filter(
                        // Drop comments authored by Kody itself — otherwise
                        // the rule-generator LLM learns from Kody's own
                        // past reviews and creates duplicate rules on
                        // subsequent onboardings (self-feedback loop).
                        // Both provider signatures are checked centrally
                        // via `isKodyAuthoredBody` — see
                        // `libs/common/utils/kody-identifiers.ts` for why
                        // bitbucket needs a different marker form than
                        // github / gitlab / azure / forgejo.
                        (comment) => !isKodyAuthoredBody(comment?.body),
                    )
                    ?.filter((comment) => comment?.body?.length > 100);

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

            const count = files.reduce<Record<string, number>>(
                (acc, file) => {
                    const extension = file.filename.split('.').pop();
                    acc[extension] = (acc[extension] || 0) + 1;
                    return acc;
                },
                {},
            );

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
