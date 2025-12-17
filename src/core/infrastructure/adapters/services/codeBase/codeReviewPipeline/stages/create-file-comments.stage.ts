import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PinoLoggerService } from '../../../logger/pino.service';
import {
    ClusteringType,
    CodeReviewConfig,
    CodeSuggestion,
    CommentResult,
    FileChange,
    Repository,
} from '@/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@/core/domain/codeBase/contracts/SuggestionService.contract';
import { CodeManagementService } from '../../../platformIntegration/codeManagement.service';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { AutomationExecutionEntity } from '@/core/domain/automation/entities/automation-execution.entity';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestsEntity } from '@/core/domain/pullRequests/entities/pullRequests.entity';
import { PullRequestReviewComment } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/team-automation.service';
import { AutomationType } from '@/core/domain/automation/enums/automation-type';
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@/core/domain/dryRun/contracts/dryRun.service.contract';

@Injectable()
export class CreateFileCommentsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CreateFileCommentsStage';

    constructor(
        private readonly logger: PinoLoggerService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,

        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,

        private readonly codeManagementService: CodeManagementService,
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
        await this.resolveCommentsWithImplementedSuggestions({
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

            const commits =
                await this.codeManagementService.getCommitsForPullRequestForCodeReview(
                    {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repository: context.repository,
                        prNumber: context.pullRequest.number,
                    },
                );

            if (!commits?.length) {
                return context;
            }

            const lastAnalyzedCommit = commits[commits.length - 1];

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

        // Sort and prioritize suggestions
        const { sortedPrioritizedSuggestions, allDiscardedSuggestions } =
            await this.suggestionService.sortAndPrioritizeSuggestions(
                organizationAndTeamData,
                codeReviewConfig,
                pullRequest,
                validSuggestionsToAnalyze,
                discardedSuggestionsBySafeGuard,
            );

        // Create line comments
        const { commentResults, lastAnalyzedCommit } =
            await this.createLineComments(
                organizationAndTeamData,
                pullRequest,
                sortedPrioritizedSuggestions,
                repository,
                codeReviewConfig,
                platformType,
                dryRun,
                context.pullRequestMessagesConfig?.globalSettings
                    ?.suggestionCopyPrompt,
            );

        // Save pull request suggestions
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
        );

        return {
            lineComments: commentResults,
            lastAnalyzedCommit,
        };
    }

    private calculateStartLine(suggestion: any) {
        if (
            suggestion.relevantLinesStart === undefined ||
            suggestion.relevantLinesStart === suggestion.relevantLinesEnd
        ) {
            return undefined;
        }
        return suggestion.relevantLinesStart + 15 > suggestion.relevantLinesEnd
            ? suggestion.relevantLinesStart
            : undefined;
    }

    private calculateEndLine(suggestion: any) {
        if (
            suggestion.relevantLinesStart === undefined ||
            suggestion.relevantLinesStart === suggestion.relevantLinesEnd
        ) {
            return suggestion.relevantLinesEnd;
        }
        return suggestion.relevantLinesStart + 15 > suggestion.relevantLinesEnd
            ? suggestion.relevantLinesEnd
            : suggestion.relevantLinesStart;
    }

    private async createLineComments(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        sortedPrioritizedSuggestions: any[],
        repository: Partial<Repository>,
        codeReviewConfig: CodeReviewConfig,
        platformType: string,
        dryRun: CodeReviewPipelineContext['dryRun'],
        suggestionCopyPrompt?: boolean,
    ) {
        try {
            const lineComments = sortedPrioritizedSuggestions
                .filter(
                    (suggestion) =>
                        suggestion.clusteringInformation?.type !==
                        ClusteringType.RELATED,
                )
                .map((suggestion) => ({
                    path: suggestion.relevantFile,
                    body: {
                        language: repository?.language,
                        improvedCode: suggestion?.improvedCode,
                        suggestionContent: suggestion?.suggestionContent,
                        actionStatement:
                            suggestion?.clusteringInformation
                                ?.actionStatement || '',
                    },
                    start_line: this.calculateStartLine(suggestion),
                    line: this.calculateEndLine(suggestion),
                    side: 'RIGHT',
                    suggestion,
                }));

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

            const lastExecution =
                await this.findLastTeamAutomationCodeReviewExecution(
                    organizationAndTeamData.teamId,
                    pullRequest.number,
                    repository.id,
                );

            return {
                lastAnalyzedCommit:
                    lastExecution?.dataExecution?.lastAnalyzedCommit,
                commentResults: [],
            };
        }
    }

    private async findLastTeamAutomationCodeReviewExecution(
        teamId: string,
        pullRequestNumber: number,
        repositoryId: string,
    ) {
        const teamAutomations = await this.teamAutomationService.find({
            team: {
                uuid: teamId,
            },
        });

        if (!teamAutomations || teamAutomations?.length === 0) {
            return null;
        }

        const codeReviewAutomation = teamAutomations.find(
            (ta) =>
                ta.automation?.automationType ===
                AutomationType.AUTOMATION_CODE_REVIEW,
        );

        if (!codeReviewAutomation) {
            return null;
        }

        const lastTeamAutomationCodeReviewExecution: AutomationExecutionEntity =
            await this.automationExecutionService.findLatestExecutionByFilters({
                status: AutomationStatus.SUCCESS,
                teamAutomation: { uuid: codeReviewAutomation.uuid },
                pullRequestNumber: pullRequestNumber,
                repositoryId: repositoryId,
            });

        return lastTeamAutomationCodeReviewExecution;
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

        const suggestionsWithStatus =
            await this.suggestionService.verifyIfSuggestionsWereSent(
                organizationAndTeamData,
                pullRequest,
                sortedPrioritizedSuggestions,
                commentResults,
            );

        const pullRequestCommits =
            await this.codeManagementService.getCommitsForPullRequestForCodeReview(
                {
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequest.number,
                },
            );

        await this.pullRequestService.aggregateAndSaveDataStructure(
            pullRequest,
            repository,
            enrichedFiles,
            suggestionsWithStatus,
            discardedSuggestions,
            platformType,
            organizationAndTeamData,
            pullRequestCommits,
        );
    }

    private async resolveCommentsWithImplementedSuggestions({
        organizationAndTeamData,
        repository,
        prNumber,
        platformType,
        dryRun,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        platformType: PlatformType;
        dryRun: CodeReviewPipelineContext['dryRun'];
    }) {
        if (dryRun?.enabled) {
            return;
        }

        try {
            const codeManagementRequestData = {
                organizationAndTeamData,
                repository: {
                    id: repository.id,
                    name: repository.name,
                },
                prNumber: prNumber,
            };

            let isPlatformTypeGithub: boolean =
                platformType === PlatformType.GITHUB;

            const pr =
                await this.pullRequestService.findByNumberAndRepositoryName(
                    prNumber,
                    repository.name,
                    organizationAndTeamData,
                );

            if (!pr) {
                this.logger.warn({
                    message: `PR #${prNumber} not found, skipping comment resolution.`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repositoryName: repository.name,
                    },
                });
                return;
            }

            let implementedSuggestionsCommentIds =
                this.getImplementedSuggestionsCommentIds(pr);

            let reviewComments = [];

            /**
             * Marking comments as resolved in github needs to be done using another API.
             * Marking comments as resolved in github also is done using threadId rather than the comment Id.
             */
            if (isPlatformTypeGithub) {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewThreads(
                        codeManagementRequestData,
                        PlatformType.GITHUB,
                    );
            } else {
                reviewComments =
                    await this.codeManagementService.getPullRequestReviewComments(
                        codeManagementRequestData,
                    );
            }

            if (reviewComments?.length === 0) {
                this.logger.warn({
                    message: `No review comments found for PR#${prNumber}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        repositoryName: repository.name,
                    },
                });
                return;
            }

            const foundComments = isPlatformTypeGithub
                ? reviewComments.filter((comment) =>
                      implementedSuggestionsCommentIds.includes(
                          Number(comment.fullDatabaseId),
                      ),
                  )
                : reviewComments.filter((comment) =>
                      implementedSuggestionsCommentIds.includes(comment.id),
                  );

            if (foundComments?.length > 0) {
                const promises = foundComments.map(
                    async (foundComment: PullRequestReviewComment) => {
                        let commentId =
                            platformType === PlatformType.BITBUCKET
                                ? foundComment.id
                                : foundComment.threadId;

                        return this.codeManagementService.markReviewCommentAsResolved(
                            {
                                organizationAndTeamData,
                                repository,
                                prNumber: pr.number,
                                commentId: commentId,
                            },
                        );
                    },
                );

                // timeout mechanism for the Promise.allSettled operation to prevent potential hanging.
                await Promise.race([
                    Promise.allSettled(promises),
                    new Promise((_, reject) =>
                        setTimeout(
                            () => reject(new Error('Operation timed out')),
                            30000,
                        ),
                    ),
                ]);
            }
        } catch (error) {
            this.logger.error({
                message: `Error while resolving comments for PR#${prNumber}`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    repositoryName: repository.name,
                },
            });
            return;
        }
    }

    private getImplementedSuggestionsCommentIds(
        pr: PullRequestsEntity,
    ): number[] {
        const implementedSuggestionsCommentIds: number[] = [];

        pr.files?.forEach((file) => {
            if (file.suggestions.length > 0) {
                file.suggestions
                    ?.filter(
                        (suggestion) =>
                            suggestion.comment &&
                            suggestion.implementationStatus !==
                                ImplementationStatus.NOT_IMPLEMENTED &&
                            suggestion.deliveryStatus === DeliveryStatus.SENT,
                    )
                    .forEach((filteredSuggestion) => {
                        implementedSuggestionsCommentIds.push(
                            filteredSuggestion.comment.id,
                        );
                    });
            }
        });

        return implementedSuggestionsCommentIds;
    }
}
