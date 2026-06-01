import { createLogger } from '@kodus/flow';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/SuggestionService.contract';
import {
    calculateCommentEndLine,
    calculateCommentStartLine,
} from '@libs/common/utils/comment-builder.utils';
import { PlatformType } from '@libs/core/domain/enums';
import {
    ClusteringType,
    CodeReviewConfig,
    CodeSuggestion,
    CommentResult,
    FileChange,
    FallbackSuggestionsBySeverity,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@libs/dryRun/domain/contracts/dryRun.service.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { Inject, Injectable } from '@nestjs/common';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { ICommit } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

@Injectable()
export class CreateFileCommentsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CreateFileCommentsStage';
    readonly label = 'Posting File Comments';
    readonly visibility = StageVisibility.PRIMARY;
    private readonly logger = createLogger(CreateFileCommentsStage.name);

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // Validações fundamentais de segurança
        if (!context?.organizationAndTeamData) {
            this.logger.error({
                message: 'Missing organizationAndTeamData in context',
                context: this.stageName,
            });
            return context;
        }

        if (!context?.pullRequest?.number) {
            this.logger.error({
                message: 'Missing pullRequest data in context',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return context;
        }

        if (!context?.repository?.name || !context?.repository?.id) {
            this.logger.error({
                message: 'Missing repository data in context',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });
            return context;
        }

        // Verificar se há sugestões para processar
        const validSuggestions = context?.validSuggestions || [];
        const discardedSuggestions = context?.discardedSuggestions || [];
        const changedFiles = context?.changedFiles || [];

        // Resolve comments that refer to suggestions partially or fully implemented
        await this.suggestionService.resolveImplementedSuggestionsOnPlatform({
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            prNumber: context.pullRequest.number,
            platformType: context.platformType as PlatformType,
            dryRun: context.dryRun,
        });

        if (validSuggestions.length === 0) {
            this.logger.log({
                message: `No file-level suggestions to process for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    discardedSuggestionsCount: discardedSuggestions.length,
                },
            });

            // Even without valid suggestions, we need to save discarded suggestions to database
            // Usar todos os commits para determinar o lastAnalyzedCommit
            const allCommits = context.prAllCommits;

            if (!allCommits?.length) {
                return context;
            }

            const lastAnalyzedCommit = allCommits[allCommits.length - 1];

            // Persist changed files (and any discarded suggestions) even when
            // there are no valid suggestions — otherwise PRs with nothing to
            // comment on land in Mongo with files: [].
            try {
                await this.savePullRequestSuggestions(
                    context.organizationAndTeamData,
                    context.pullRequest,
                    context.repository,
                    changedFiles,
                    [], // No comment results since no suggestions were sent
                    [], // No prioritized suggestions
                    discardedSuggestions,
                    context.platformType,
                    context.fileMetadata,
                    context.dryRun,
                    allCommits,
                );

                this.logger.log({
                    message: `Saved PR#${context.pullRequest.number} with ${changedFiles.length} files and ${discardedSuggestions.length} discarded suggestions`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        changedFilesCount: changedFiles.length,
                        discardedSuggestionsCount: discardedSuggestions.length,
                    },
                });
            } catch (error) {
                this.logger.error({
                    message: `Error saving PR#${context.pullRequest.number} (no valid suggestions branch)`,
                    context: this.stageName,
                    error,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });
            }

            return this.updateContext(context, (draft) => {
                draft.lineComments = [];
                draft.lastAnalyzedCommit = lastAnalyzedCommit;
            });
        }

        try {
            this.logger.log({
                message: `Starting file comments creation for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    validSuggestionsCount: validSuggestions.length,
                    discardedSuggestionsCount: discardedSuggestions.length,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            const { lineComments, lastAnalyzedCommit } =
                await this.finalizeReviewProcessing(
                    context,
                    changedFiles,
                    validSuggestions,
                    discardedSuggestions,
                );

            this.logger.log({
                message: `Successfully processed file comments for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    lineCommentsCreated: lineComments.length,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.lineComments = lineComments;
                draft.lastAnalyzedCommit = lastAnalyzedCommit;
            });
        } catch (error) {
            this.logger.error({
                message: `Error during file comments creation for PR#${context.pullRequest.number}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    validSuggestionsCount: validSuggestions.length,
                },
            });

            // Em caso de erro, retorna contexto com valores padrão
            return this.updateContext(context, (draft) => {
                draft.lineComments = [];
                draft.lastAnalyzedCommit = null;
            });
        }
    }

    /**
     * Finalizes the code review process by generating comments and saving suggestions
     * @param context Pipeline context
     * @param changedFiles Files changed in the PR
     * @param validSuggestionsToAnalyze Valid suggestions found
     * @param discardedSuggestionsBySafeGuard Discarded suggestions
     * @returns Processing result with comments and suggestions
     */
    private async finalizeReviewProcessing(
        context: CodeReviewPipelineContext,
        changedFiles: FileChange[],
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
    ): Promise<{
        lineComments: Array<CommentResult>;
        lastAnalyzedCommit: any;
    }> {
        const {
            organizationAndTeamData,
            pullRequest,
            codeReviewConfig,
            repository,
            platformType,
            dryRun,
        } = context;

        // v3 pipeline: suggestions are already severity-normalized and deduplicated
        // by agent-review.stage. No additional severity/quantity filtering needed.
        //
        // Sort before posting so all comments for the same file land together on
        // GitHub, and within a file the most severe ones surface first.
        const severityOrder: Record<string, number> = {
            critical: 4,
            high: 3,
            medium: 2,
            low: 1,
        };
        const sortedPrioritizedSuggestions = [...validSuggestionsToAnalyze].sort(
            (a, b) => {
                const fileA = a.relevantFile || '';
                const fileB = b.relevantFile || '';
                if (fileA < fileB) return -1;
                if (fileA > fileB) return 1;
                const rankA = severityOrder[(a.severity || '').toLowerCase()] ?? 0;
                const rankB = severityOrder[(b.severity || '').toLowerCase()] ?? 0;
                return rankB - rankA;
            },
        );
        const allDiscardedSuggestions = [...discardedSuggestionsBySafeGuard];

        const fallbackSuggestionsBySeverity =
            this.groupDiscardedByQuantitySuggestions(allDiscardedSuggestions);

        // Create line comments
        const { commentResults, lastAnalyzedCommit } =
            await this.createLineComments(
                organizationAndTeamData,
                pullRequest,
                sortedPrioritizedSuggestions,
                repository,
                codeReviewConfig,
                dryRun,
                context.pipelineMetadata?.lastExecution?.dataExecution
                    ?.lastAnalyzedCommit || null,
                context.pullRequestMessagesConfig?.globalSettings
                    ?.suggestionCopyPrompt,
                fallbackSuggestionsBySeverity,
                allDiscardedSuggestions,
                changedFiles,
            );

        // Save pull request suggestions — comments already posted at this point
        try {
            await this.savePullRequestSuggestions(
                organizationAndTeamData,
                pullRequest,
                repository,
                changedFiles,
                commentResults,
                sortedPrioritizedSuggestions,
                allDiscardedSuggestions,
                platformType,
                context.fileMetadata,
                dryRun,
                context.prAllCommits,
            );
        } catch (error) {
            this.logger.error({
                message: `Error saving suggestions for PR#${pullRequest.number} — comments were already posted`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest.number,
                    commentResultsCount: commentResults.length,
                },
            });
        }

        return {
            lineComments: commentResults,
            lastAnalyzedCommit,
        };
    }

    private groupDiscardedByQuantitySuggestions(
        allDiscardedSuggestions: Partial<CodeSuggestion>[],
    ): FallbackSuggestionsBySeverity {
        const fallbackSuggestions: FallbackSuggestionsBySeverity = {
            critical: [],
            high: [],
            medium: [],
            low: [],
        };

        for (const suggestion of allDiscardedSuggestions) {
            if (
                suggestion.priorityStatus ===
                PriorityStatus.DISCARDED_BY_QUANTITY
            ) {
                const severity =
                    (suggestion.severity?.toLowerCase() as keyof FallbackSuggestionsBySeverity) ||
                    'low';
                if (fallbackSuggestions[severity]) {
                    fallbackSuggestions[severity].push(suggestion);
                }
            }
        }

        return fallbackSuggestions;
    }

    private async createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        sortedPrioritizedSuggestions: any[],
        repository: Partial<Repository>,
        codeReviewConfig: CodeReviewConfig,
        dryRun: CodeReviewPipelineContext['dryRun'],
        lastAnalyzedCommitFromContext: any,
        suggestionCopyPrompt?: boolean,
        fallbackSuggestionsBySeverity?: FallbackSuggestionsBySeverity,
        allDiscardedSuggestions?: Partial<CodeSuggestion>[],
        changedFiles: FileChange[] = [],
    ) {
        try {
            // Children in a cluster are merged into their parent's
            // actionStatement upstream, so we skip posting them as
            // separate comments. Mark them with DISCARDED_BY_CLUSTERING
            // so they still reach Mongo instead of vanishing silently
            // — helps reconcile when a cluster link gets orphaned.
            const relatedOrphans = sortedPrioritizedSuggestions.filter(
                (s) =>
                    s.clusteringInformation?.type === ClusteringType.RELATED,
            );
            if (relatedOrphans.length > 0 && allDiscardedSuggestions) {
                for (const orphan of relatedOrphans) {
                    allDiscardedSuggestions.push({
                        ...orphan,
                        priorityStatus:
                            PriorityStatus.DISCARDED_BY_CLUSTERING,
                    });
                }
                this.logger.log({
                    message: `[CREATE-COMMENTS] ${relatedOrphans.length} related cluster children marked DISCARDED_BY_CLUSTERING`,
                    context: this.stageName,
                    metadata: {
                        prNumber: pullRequest.number,
                        count: relatedOrphans.length,
                    },
                });
            }

            // Skip suggestions pointing at files deleted in this PR — posting
            // a comment on a removed file fails on every git provider (no line
            // to attach to) and creates misleading reviews.
            const removedFiles = new Set(
                changedFiles
                    .filter((f) => f?.status === 'removed')
                    .map((f) => f.filename),
            );

            const lineComments = sortedPrioritizedSuggestions
                .filter(
                    (suggestion) =>
                        suggestion.clusteringInformation?.type !==
                            ClusteringType.RELATED &&
                        !removedFiles.has(suggestion.relevantFile),
                )
                .map((suggestion) => {
                    return {
                        path: suggestion.relevantFile,
                        body: {
                            language: repository?.language,
                            improvedCode: suggestion?.improvedCode,
                            suggestionContent: suggestion?.suggestionContent,
                            actionStatement:
                                suggestion?.clusteringInformation
                                    ?.actionStatement || '',
                        },
                        start_line: calculateCommentStartLine(suggestion),
                        line: calculateCommentEndLine(suggestion),
                        side: 'RIGHT',
                        suggestion,
                    };
                });

            const { lastAnalyzedCommit, commentResults } =
                await this.commentManagerService.createLineComments(
                    organizationAndTeamData,
                    pullRequest?.number,
                    {
                        name: repository.name,
                        id: repository.id,
                        language: repository.language,
                    },
                    lineComments,
                    codeReviewConfig?.languageResultPrompt,
                    dryRun,
                    suggestionCopyPrompt,
                    fallbackSuggestionsBySeverity,
                );

            return { lastAnalyzedCommit, commentResults };
        } catch (error) {
            this.logger.error({
                message: `Error when trying to create line comments for PR#${pullRequest.number}`,
                error: error,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest.number,
                    repositoryName: repository?.name,
                },
            });
            return {
                lastAnalyzedCommit: lastAnalyzedCommitFromContext,
                commentResults: [],
            };
        }
    }

    private async savePullRequestSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        repository: Partial<Repository>,
        changedFiles: FileChange[],
        commentResults: CommentResult[],
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[],
        discardedSuggestions: Partial<CodeSuggestion>[],
        platformType: string,
        fileMetadata?: Map<string, any>,
        dryRun?: CodeReviewPipelineContext['dryRun'],
        prCommits?: Commit[],
    ) {
        const enrichedFiles = changedFiles.map((file) => {
            const metadata = fileMetadata?.get(file.filename);
            if (metadata) {
                return {
                    ...file,
                    reviewMode: metadata.reviewMode,
                    codeReviewModelUsed: metadata.codeReviewModelUsed,
                };
            }
            return file;
        });

        if (dryRun?.enabled) {
            await this.dryRunService.addFilesToDryRun({
                organizationAndTeamData,
                id: dryRun?.id,
                files: enrichedFiles,
                prioritizedSuggestions: sortedPrioritizedSuggestions as any,
                unusedSuggestions: discardedSuggestions as any,
            });

            return;
        }

        // Update status for originally prioritized suggestions based on comment results
        const suggestionsWithStatus =
            await this.suggestionService.verifyIfSuggestionsWereSent(
                organizationAndTeamData,
                pullRequest,
                sortedPrioritizedSuggestions,
                commentResults,
            );

        // Extract repriorized suggestions (fallback suggestions that were sent)
        // and remove them from discarded to avoid duplicate saves
        const { repriorizedSuggestions, filteredDiscardedSuggestions } =
            this.suggestionService.extractRepriorizedSuggestions(
                commentResults,
                discardedSuggestions,
            );

        // Combine original prioritized suggestions with repriorized ones
        const allPrioritizedSuggestions = [
            ...suggestionsWithStatus,
            ...repriorizedSuggestions,
        ];

        // Reutilizar commits do context (buscados no ValidateNewCommitsStage)
        const pullRequestCommits = prCommits || [];

        await this.pullRequestService.aggregateAndSaveDataStructure(
            pullRequest,
            repository,
            enrichedFiles,
            allPrioritizedSuggestions,
            filteredDiscardedSuggestions,
            platformType,
            organizationAndTeamData,
            pullRequestCommits as unknown as ICommit[],
        );
    }
}
