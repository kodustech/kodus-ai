import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { Output } from 'ai';
import z from 'zod';
import filteredLibraryKodyRules from '@libs/code-review/infrastructure/data/filtered-rules.json';
import { Injectable } from '@nestjs/common';
import { v4 } from 'uuid';

import { LLM_TASK } from '@libs/llm/byok-config';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';
import {
    LLM_CALL_TIMEOUT_MS,
    timeoutSignal,
    tracedGenerateText,
} from '@libs/llm/llm-call';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';

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
} from '@libs/common/utils/prompts/commentAnalysis';
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
} from '@libs/common/utils/prompts/kodyRulesGenerator';
import { DocumentationContextItem } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { LibraryKodyRule } from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IKodyRule,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Resolved model selection for a Kody Rules LLM call. BYOK wins when present;
 * otherwise `modelOverride` forces the managed trial model (DeepSeek V4 Flash
 * on Fireworks); both undefined resolves the self-hosted env model. Produced by
 * `resolveKodyRulesModelPolicy`.
 */
export interface KodyRulesModelSelection {
    byokConfig?: NormalizedModel;
    modelOverride?: string;
}

@Injectable()
export class CommentAnalysisService {
    private readonly logger = createLogger(CommentAnalysisService.name);
    constructor(
        private readonly observabilityService: ObservabilityService,
        private readonly permissionValidationService: PermissionValidationService,
    ) {}

    /**
     * Runs a structured-output LLM call, resolving the model the SAME way the
     * code-review agents do (see `resolveReviewAgentModel` / model-factory):
     * `resolveTaskModel(v2Config, LLM_TASK.codeReview, …)` over the org's raw config
     * — BYOK wins; self-hosted resolves the env model; cloud trial forces the
     * managed model (DeepSeek V4 Flash on Fireworks) via `modelOverride` (the
     * default-model override); cloud without BYOK is already skipped upstream by
     * the model policy. `wrapByokModel` adds the shared concurrency limiter +
     * error classification. Non-strict structured output so schemas with optional
     * fields work across providers. LLM failures propagate — callers must not
     * treat them as "no result".
     */
    private async runStructuredLLM<S extends z.ZodType>(args: {
        organizationAndTeamData: OrganizationAndTeamData;
        modelConfig: KodyRulesModelSelection;
        schema: S;
        system: string;
        user: string;
        runName: string;
        attrs?: Record<string, unknown>;
    }): Promise<z.infer<S>> {
        const {
            organizationAndTeamData,
            modelConfig,
            schema,
            system,
            user,
            runName,
            attrs,
        } = args;

        // Resolve the codeReview slot from the org's raw config (matching
        // model-factory). `modelOverride` is the default-model override (trial
        // forces Kimi); it only applies when there is no BYOK. Off-BYOK yields
        // the env/managed default.
        const resolved =
            await this.permissionValidationService.resolveTaskModel(
                organizationAndTeamData,
                LLM_TASK.codeReview,
                { defaultModelOverride: modelConfig.modelOverride },
            );
        const model = wrapByokModel(resolved.model, {
            byokConfig: resolved.slot ?? undefined,
            organizationId: organizationAndTeamData.organizationId,
            role: 'main',
        });

        const result = await this.observabilityService.runAiSdkLLMInSpan<any>({
            spanName: `${CommentAnalysisService.name}::${runName}`,
            runName,
            model: resolved.modelName,
            // Attribute BYOK-vs-system so this org's comment-analysis spend lands
            // in its BYOK usage view (a resolved slot = the org's own key).
            attrs: {
                ...(attrs ?? {}),
                type:
                    ((attrs as Record<string, unknown>)?.type as
                        | string
                        | undefined) ?? (resolved.slot ? 'byok' : 'system'),
            },
            // Structured output via generateText + Output.object (generateObject
            // is deprecated in ai@6). The casts bridge the generic
            // `S extends z.ZodType` to the SDK's schema type while the public
            // return stays typed as `z.infer<S>`.
            exec: () =>
                tracedGenerateText({
                    model: model as any,
                    system,
                    prompt: user,
                    output: Output.object({ schema: schema as any }),
                    abortSignal: timeoutSignal(LLM_CALL_TIMEOUT_MS),
                    ...toAiSdkTelemetryArgs(
                        buildLangfuseTelemetry(runName, {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                        }),
                    ),
                } as any),
        });

        return (result.experimental_output ?? result.output) as z.infer<S>;
    }

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

            // The codeReview slot is resolved inside runStructuredLLM from the
            // raw config (native); no legacy byokConfig needed here.
            const categorizedCommentsRes = await this.runStructuredLLM({
                organizationAndTeamData,
                modelConfig: {},
                schema: commentCategorizerSchema,
                system: prompt_CommentCategorizerSystem(),
                user: prompt_CommentCategorizerUser({
                    comments: filteredComments,
                }),
                runName: 'commentCategorizer',
                attrs: { commentsCount: filteredComments.length },
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
        modelConfig?: KodyRulesModelSelection;
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

        // The use-case/cron pass the policy-resolved selection (its
        // `modelOverride` still honored). When called without one, the codeReview
        // slot is resolved inside runStructuredLLM from the raw config.
        const modelConfig: KodyRulesModelSelection = params.modelConfig ?? {};

        // NOTE: no swallowing try/catch here — an LLM failure must propagate so
        // the use-case marks the run as errored instead of "0 rules, success".
        const filteredComments = await this.filterComments({
            comments,
            organizationAndTeamData,
            modelConfig,
        });

        if (!filteredComments || filteredComments.length === 0) {
            this.logger.log({
                message: 'No comments to generate Kody rules after filtering',
                context: CommentAnalysisService.name,
                metadata: { organizationAndTeamData },
            });
            return [];
        }

        const generatedRes = await this.runStructuredLLM({
            organizationAndTeamData,
            modelConfig,
            schema: kodyRulesGeneratorSchema,
            system: prompt_KodyRulesGeneratorSystem(),
            user: prompt_KodyRulesGeneratorUser({
                comments: filteredComments,
                rules: filteredLibraryKodyRules,
                memories,
                documentationContext,
            }),
            runName: 'generateKodyRules.generate',
            attrs: { commentsCount: filteredComments.length },
        });

        const generated = generatedRes?.rules as Partial<IKodyRule>[];

        if (!generated || generated.length === 0) {
            this.logger.log({
                message: 'No rules generated',
                context: CommentAnalysisService.name,
                metadata: { organizationAndTeamData },
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
                (rule as Partial<LibraryKodyRule>)?.why_is_this_important || '',
        })) as LibraryKodyRule[];

        let deduplicatedRules = generatedWithUuids;
        if (existingRules && existingRules.length > 0) {
            const deduplicatedRulesUuidsRes = await this.runStructuredLLM({
                organizationAndTeamData,
                modelConfig,
                schema: kodyRulesGeneratorDuplicateFilterSchema,
                system: prompt_KodyRulesGeneratorDuplicateFilterSystem(),
                user: prompt_KodyRulesGeneratorDuplicateFilterUser({
                    existingRules: existingRulesAsLibrary,
                    newRules: generatedWithUuids,
                }),
                runName: 'generateKodyRules.dedupe',
                attrs: {
                    newRulesCount: generatedWithUuids.length,
                    existingRulesCount: existingRulesAsLibrary.length,
                },
            });

            const deduplicatedRulesUuids = deduplicatedRulesUuidsRes?.uuids;

            if (!deduplicatedRulesUuids || deduplicatedRulesUuids.length === 0) {
                this.logger.log({
                    message: 'No rules after deduplication',
                    context: CommentAnalysisService.name,
                    metadata: { organizationAndTeamData },
                });
                return [];
            }

            deduplicatedRules = this.mapRuleUuidToRule({
                rules: generatedWithUuids,
                uuids: deduplicatedRulesUuids,
            });
        }

        const filteredRulesUuidsRes = await this.runStructuredLLM({
            organizationAndTeamData,
            modelConfig,
            schema: kodyRulesGeneratorQualityFilterSchema,
            system: prompt_KodyRulesGeneratorQualityFilterSystem(),
            user: prompt_KodyRulesGeneratorQualityFilterUser({
                rules: deduplicatedRules,
            }),
            runName: 'generateKodyRules.quality',
            attrs: { candidateRulesCount: deduplicatedRules.length },
        });

        const filteredRulesUuids = filteredRulesUuidsRes?.uuids;

        if (!filteredRulesUuids || filteredRulesUuids.length === 0) {
            this.logger.log({
                message: 'No rules after quality filter',
                context: CommentAnalysisService.name,
                metadata: { organizationAndTeamData },
            });
            return [];
        }

        const filteredRules = this.mapRuleUuidToRule({
            rules: deduplicatedRules,
            uuids: filteredRulesUuids,
        });

        return this.standardizeRules({ rules: filteredRules });
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
        modelConfig?: KodyRulesModelSelection;
    }): Promise<UncategorizedComment[]> {
        const { comments, organizationAndTeamData } = params;

        // Resolved inside runStructuredLLM from the raw config when no
        // policy-resolved selection is passed (native).
        const modelConfig: KodyRulesModelSelection = params.modelConfig ?? {};

        // No swallowing catch — a provider failure must propagate so the run
        // is marked errored. An empty result (no relevant comments) is a
        // legitimate outcome and returns [], distinct from a failure.
        const filteredCommentsIdsRes = await this.runStructuredLLM({
            organizationAndTeamData,
            modelConfig,
            schema: commentIrrelevanceFilterSchema,
            system: prompt_CommentIrrelevanceFilterSystem(),
            user: prompt_CommentIrrelevanceFilterUser({ comments }),
            runName: 'commentIrrelevanceFilter',
            attrs: { commentsCount: comments.length },
        });

        const filteredCommentsIds = filteredCommentsIdsRes?.ids;

        if (!filteredCommentsIds || filteredCommentsIds.length === 0) {
            this.logger.log({
                message: 'No relevant comments after irrelevance filter',
                context: CommentAnalysisService.name,
                metadata: { organizationAndTeamData },
            });
            return [];
        }

        return comments.filter((comment) =>
            filteredCommentsIds.includes(comment.id.toString()),
        );
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
        // Provider-native user ids whose comments must be dropped before
        // learning (issue #1497). Denylist — empty/undefined keeps everyone.
        excludedReviewerIds?: Set<string>,
    ) {
        const hasExclusions = !!excludedReviewerIds && excludedReviewerIds.size > 0;

        const processedComments = comments
            .map((pr) => {
                const allComments = [
                    ...pr.generalComments,
                    ...pr.reviewComments,
                ];

                const mappedComments = allComments.flatMap((comment) => {
                    if (!('body' in comment)) {
                        // GitLab discussion notes. Carry `author` so the
                        // reviewer-exclusion filter below can identify them —
                        // GitLab keys the author on `author`, not `user`.
                        return comment.notes.flatMap((note) => ({
                            id: note.id,
                            body: note.body,
                            author: note.author,
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
                    ?.filter((comment) => {
                        // Reviewer denylist (issue #1497): drop comments from
                        // excluded git users. Keep when we can't identify the
                        // author, so a denylist never silently removes an
                        // unidentifiable reviewer's comments.
                        if (!hasExclusions) {
                            return true;
                        }
                        const authorId = this.getCommentAuthorId(comment);
                        return !authorId || !excludedReviewerIds.has(authorId);
                    })
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

    /**
     * Provider-native author id of a raw review comment, as a string, for
     * matching against the reviewer denylist. GitHub/Azure key the author on
     * `user`, GitLab on `author`; ids are numeric on GitHub/GitLab and a GUID
     * on Azure, so everything is normalized to string. Returns undefined when
     * the author can't be identified.
     */
    private getCommentAuthorId(comment: any): string | undefined {
        const rawId = comment?.user?.id ?? comment?.author?.id;
        if (rawId === undefined || rawId === null || rawId === '') {
            return undefined;
        }
        return String(rawId);
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
