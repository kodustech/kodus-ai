/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { Injectable, Inject } from '@nestjs/common';
import { PipelineFactory } from '../pipeline/pipeline-factory.service';
import { v4 as uuidv4 } from 'uuid';

import pLimit from 'p-limit';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '../../../../domain/codeBase/contracts/CommentManagerService.contract';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

import {
    FileChange,
    AnalysisContext,
    CodeReviewConfig,
    Repository,
    CodeSuggestion,
    ClusteringType,
    CommentResult,
    IFinalAnalysisResult,
    ReviewModeResponse,
    AIAnalysisResult,
} from '@/config/types/general/codeReview.type';
import { PinoLoggerService } from '../logger/pino.service';
import { AutomationExecutionEntity } from '@/core/domain/automation/entities/automation-execution.entity';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '../../../../domain/codeBase/contracts/PullRequestManagerService.contract';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '../../../../domain/codeBase/contracts/CodeBaseConfigService.contract';
import { IAIAnalysisService } from '../../../../domain/codeBase/contracts/AIAnalysisService.contract';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { LLM_ANALYSIS_SERVICE_TOKEN } from './llmAnalysis.service';
import {
    GetChangedFilesResult,
    ValidateConfigResult,
} from './types/index.type';
import { GetOrCreateInitialCommentResult } from './types/index.type';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { CodeManagementService } from '../platformIntegration/codeManagement.service';

import {
    AST_ANALYSIS_SERVICE_TOKEN,
    IASTAnalysisService,
} from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@/core/domain/codeBase/contracts/SuggestionService.contract';
import { createOptimizedBatches } from '@/shared/utils/batch.helper';
import { benchmark } from '@/shared/utils/benchmark.util';
import {
    FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    IFileReviewContextPreparation,
} from '@/shared/interfaces/file-review-context-preparation.interface';
import { KodyFineTuningService } from '@/ee/kodyFineTuning/kodyFineTuning.service';
import { IClusterizedSuggestion } from '@/ee/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';
import { CodeReviewPipelineContext } from './codeReviewPipeline/context/code-review-pipeline.context';
import { PipelineStatus } from '../pipeline/interfaces/pipeline-context.interface';
import { CodeAnalysisOrchestrator } from '@/ee/codeBase/codeAnalysisOrchestrator.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestsEntity } from '@/core/domain/pullRequests/entities/pullRequests.entity';
import { PullRequestReviewComment } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { GlobalParametersKey } from '@/shared/domain/enums/global-parameters-key.enum';
import { GlobalParametersService } from '../global-parameters.service';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@/core/domain/global-parameters/contracts/global-parameters.service.contract';

const ENABLE_CODE_REVIEW_AST =
    process.env.ENABLE_CODE_REVIEW_AST === 'true' ? true : false;

@Injectable()
export class CodeReviewHandlerService {
    private readonly concurrencyLimit = 10;
    private readonly max_files_to_analyze = 200;

    constructor(
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,

        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: IPullRequestManagerService,

        @Inject(LLM_ANALYSIS_SERVICE_TOKEN)
        private readonly aiAnalysisService: IAIAnalysisService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(AST_ANALYSIS_SERVICE_TOKEN)
        private readonly codeASTAnalysisService: IASTAnalysisService,

        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(FILE_REVIEW_CONTEXT_PREPARATION_TOKEN)
        private readonly fileReviewContextPreparation: IFileReviewContextPreparation,

        private readonly kodyFineTuningService: KodyFineTuningService,

        private readonly codeAnalysisOrchestrator: CodeAnalysisOrchestrator,

        private readonly logger: PinoLoggerService,

        private readonly codeManagementService: CodeManagementService,

        @Inject('PIPELINE_PROVIDER')
        private readonly pipelineFactory: PipelineFactory<CodeReviewPipelineContext>,

        @Inject(GLOBAL_PARAMETERS_SERVICE_TOKEN)
        private readonly globalParametersService: GlobalParametersService,
    ) { }

    private async findLastTeamAutomationCodeReviewExecution(
        teamAutomationId: string,
        pullRequestNumber: number,
        platformType: string,
    ) {
        const lastTeamAutomationCodeReviewExecution: AutomationExecutionEntity =
            await this.automationExecutionService.findLatestExecutionByDataExecutionFilter(
                { pullRequestNumber: pullRequestNumber, platformType },
                {
                    status: AutomationStatus.SUCCESS,
                    teamAutomation: { uuid: teamAutomationId },
                },
            );

        return lastTeamAutomationCodeReviewExecution;
    }

    //#region Process Analysis Result
    private async addSuggestionsId(suggestions: any[]): Promise<any[]> {
        return suggestions?.map((suggestion) => ({
            ...suggestion,
            id: uuidv4(),
        }));
    }

    private async processAnalysisResult(
        result: AIAnalysisResult,
        context: AnalysisContext,
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<IFinalAnalysisResult> {
        const { reviewModeResponse } = context;
        const { file, patchWithLinesStr } = context.fileChangeContext;

        const overallComment = {
            filepath: file.filename,
            summary: result?.overallSummary || '',
        };

        const validSuggestionsToAnalyze: Partial<CodeSuggestion>[] = [];
        const discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[] = [];
        const discardedSuggestionsByCodeDiff: Partial<CodeSuggestion>[] = [];
        const discardedSuggestionsByKodyFineTuning: Partial<CodeSuggestion>[] =
            [];
        const clusteredSuggestions: Partial<CodeSuggestion>[] = [];
        let safeguardLLMProvider = '';

        if (
            result &&
            'codeSuggestions' in result &&
            Array.isArray(result.codeSuggestions) &&
            result.codeSuggestions.length > 0
        ) {
            // Filter code suggestions by review options
            let filteredSuggestionsByOptions =
                this.suggestionService.filterCodeSuggestionsByReviewOptions(
                    context?.codeReviewConfig?.reviewOptions,
                    result,
                );

            const suggestionsWithId = await this.addSuggestionsId(
                filteredSuggestionsByOptions.codeSuggestions,
            );

            const filterSuggestionsCodeDiff =
                await this.suggestionService.filterSuggestionsCodeDiff(
                    patchWithLinesStr,
                    suggestionsWithId,
                );

            discardedSuggestionsByCodeDiff.push(
                ...this.suggestionService.getDiscardedSuggestions(
                    suggestionsWithId,
                    filterSuggestionsCodeDiff,
                    PriorityStatus.DISCARDED_BY_CODE_DIFF,
                ),
            );

            const safeGuardResponse =
                await this.suggestionService.filterSuggestionsSafeGuard(
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                    file,
                    patchWithLinesStr,
                    suggestionsWithId,
                    context?.codeReviewConfig?.languageResultPrompt,
                    reviewModeResponse,
                );

            safeguardLLMProvider =
                safeGuardResponse?.codeReviewModelUsed?.safeguard;

            discardedSuggestionsBySafeGuard.push(
                ...this.suggestionService.getDiscardedSuggestions(
                    suggestionsWithId,
                    safeGuardResponse?.suggestions || [],
                    PriorityStatus.DISCARDED_BY_SAFEGUARD,
                ),
            );

            discardedSuggestionsBySafeGuard.push(
                ...discardedSuggestionsByCodeDiff,
                ...discardedSuggestionsByKodyFineTuning,
            );

            const suggestionsWithSeverity =
                await this.suggestionService.analyzeSuggestionsSeverity(
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                    safeGuardResponse?.suggestions,
                    context?.codeReviewConfig?.reviewOptions,
                );

            // TODO
            // Mudar regra para open core
            const kodyRulesSuggestions =
                await this.codeAnalysisOrchestrator.executeKodyRulesAnalysis(
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                    { file, patchWithLinesStr },
                    context,
                    {
                        overallSummary: result?.overallSummary,
                        codeSuggestions: suggestionsWithSeverity,
                    },
                );

            let mergedSuggestions = [
                ...(kodyRulesSuggestions
                    ? kodyRulesSuggestions?.codeSuggestions
                    : suggestionsWithSeverity?.length > 0
                        ? suggestionsWithSeverity
                        : []),
            ];

            // TODO
            // Mudar regra para open core
            if (context?.reviewModeResponse === ReviewModeResponse.HEAVY_MODE) {
                const kodyASTSuggestions =
                    await this.getASTAnalysisSuggestions(context);

                mergedSuggestions = [
                    ...mergedSuggestions,
                    ...(kodyASTSuggestions
                        ? kodyASTSuggestions?.codeSuggestions
                        : []),
                ];
            }

            const VALID_ACTIONS = ['synchronize', 'update', 'updated'];

            // If it's a commit, validate repeated suggestions
            if (context?.action && VALID_ACTIONS.includes(context.action)) {
                const savedSuggestions =
                    await this.pullRequestService.findSuggestionsByPRAndFilename(
                        context?.pullRequest?.number,
                        context?.pullRequest?.base?.repo?.fullName,
                        file.filename,
                    );

                if (savedSuggestions?.length > 0) {
                    const sentSuggestions = savedSuggestions.filter(
                        (suggestion) =>
                            suggestion.deliveryStatus === DeliveryStatus.SENT &&
                            suggestion.implementationStatus ===
                            ImplementationStatus.NOT_IMPLEMENTED,
                    );

                    if (mergedSuggestions?.length > 0) {
                        mergedSuggestions =
                            await this.suggestionService.removeSuggestionsRelatedToSavedFiles(
                                context?.organizationAndTeamData,
                                context?.pullRequest?.number,
                                savedSuggestions,
                                mergedSuggestions,
                            );
                    }

                    // We can only validate the implementation of suggestions that were sent
                    if (sentSuggestions.length > 0) {
                        this.suggestionService.validateImplementedSuggestions(
                            context?.organizationAndTeamData,
                            file?.patch,
                            sentSuggestions,
                            context?.pullRequest?.number,
                        );
                    }
                }
            }

            if (mergedSuggestions?.length > 0) {
                await Promise.all(
                    mergedSuggestions.map(async (suggestion) => {
                        suggestion.rankScore =
                            await this.suggestionService.calculateSuggestionRankScore(
                                suggestion,
                            );
                    }),
                );
            }

            validSuggestionsToAnalyze.push(...mergedSuggestions);
        }

        return {
            validSuggestionsToAnalyze,
            discardedSuggestionsBySafeGuard:
                discardedSuggestionsBySafeGuard || [],
            overallComment,
            reviewMode: reviewModeResponse,
            codeReviewModelUsed: {
                generateSuggestions:
                    result?.codeReviewModelUsed?.generateSuggestions,
                safeguard: safeguardLLMProvider,
            },
        };
    }

    private async getASTAnalysisSuggestions(
        context: AnalysisContext,
    ): Promise<AIAnalysisResult | null> {
        if (context.impactASTAnalysis?.functionsAffectResult?.length) {
            return this.codeAnalysisOrchestrator.executeASTAnalysis(
                context.fileChangeContext,
                context.reviewModeResponse,
                context,
            );
        }

        return null;
    }

    //#region Post Suggestions / Create Comments
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
                );

            return { lastAnalyzedCommit, commentResults };
        } catch (error) {
            this.logger.log({
                message: `Error when trying to create line comments for PR#${pullRequest.number}`,
                error: error,
                context: CodeReviewHandlerService.name,
                metadata: {
                    organizationAndTeamData,
                    pullRequest,
                    sortedPrioritizedSuggestions,
                    repository,
                },
            });

            const lastExecution =
                await this.findLastTeamAutomationCodeReviewExecution(
                    organizationAndTeamData.teamId,
                    pullRequest.number,
                    platformType,
                );

            return {
                lastAnalyzedCommit:
                    lastExecution?.dataExecution?.lastAnalyzedCommit,
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
        platformType: PlatformType,
    ) {
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
            changedFiles,
            suggestionsWithStatus,
            discardedSuggestions,
            platformType,
            organizationAndTeamData?.organizationId,
            pullRequestCommits,
        );
    }

    private async resolveCommentsWithImplementedSuggestions({
        organizationAndTeamData,
        repository,
        prNumber,
        platformType,
    }: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: Partial<Repository>;
        prNumber: number;
        platformType: PlatformType;
    }) {
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

        const pr = await this.pullRequestService.findByNumberAndRepository(
            prNumber,
            repository.name,
        );

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

        const foundComments = isPlatformTypeGithub
            ? reviewComments.filter((comment) =>
                implementedSuggestionsCommentIds.includes(
                    Number(comment.fullDatabaseId),
                ),
            )
            : reviewComments.filter((comment) =>
                implementedSuggestionsCommentIds.includes(comment.id),
            );

        if (foundComments.length > 0) {
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

            await Promise.allSettled(promises);
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

    //#endregion

    //#region Handle Pull Request
    private shouldProcessPR(
        title: string,
        baseBranch: any,
        config: CodeReviewConfig,
        origin: string,
    ): boolean {
        const { ignoredTitleKeywords, baseBranches, automatedReviewActive } =
            config;

        if (origin === 'command') {
            return true;
        }

        if (!automatedReviewActive) {
            return false;
        }

        const shouldIgnoreTitle = ignoredTitleKeywords?.some((keyword) =>
            title.toLowerCase().includes(keyword.toLowerCase()),
        );

        if (shouldIgnoreTitle) {
            return false;
        }

        const isBaseBranchAllowed = baseBranches?.includes(baseBranch);

        return isBaseBranchAllowed;
    }

    async getAndValidateReviewConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        pullRequest: any,
        branch: string,
        origin: string,
    ): Promise<ValidateConfigResult> {
        const prNumber = pullRequest?.number;
        const repositoryName = repository?.name;

        const codeReviewConfig = await this.codeBaseConfigService.getConfig(
            organizationAndTeamData,
            { name: repository.name, id: repository.id },
        );

        if (
            !this.shouldProcessPR(
                pullRequest.title,
                pullRequest?.base?.ref,
                codeReviewConfig,
                origin,
            )
        ) {
            return {
                status: 'SKIP',
                loginfo: {
                    message: `Code Review not started because configs: ${repositoryName} - ${branch} - PR#${prNumber}`,
                    context: CodeReviewHandlerService.name,
                    metadata: {
                        title: pullRequest?.title,
                        baseBranch: pullRequest?.base?.ref,
                        prNumber,
                        config: codeReviewConfig,
                        organizationAndTeamData,
                    },
                },
            };
        }

        return { status: 'CONTINUE', codeReviewConfig: codeReviewConfig };
    }

    async getChangedFilesWithHistory(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { name: string; id: string },
        pullRequest: { number: number },
        branch: string,
        platformType: string,
        teamAutomationId: string,
        codeReviewConfig: CodeReviewConfig,
    ): Promise<GetChangedFilesResult> {
        const lastExecution =
            await this.findLastTeamAutomationCodeReviewExecution(
                teamAutomationId,
                pullRequest.number,
                platformType,
            );

        const changedFiles =
            await this.pullRequestHandlerService.getChangedFiles(
                organizationAndTeamData,
                repository,
                pullRequest,
                codeReviewConfig.ignorePaths,
                lastExecution?.dataExecution?.lastAnalyzedCommit,
            );

        if (!changedFiles?.length) {
            return {
                status: 'SKIP',
                loginfo: {
                    message: `Not changedFiles ${repository?.name} - ${branch} - PR#${pullRequest?.number}`,
                    context: CodeReviewHandlerService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository,
                        branch,
                        pullRequest,
                    },
                },
            };
        }

        const maxFilesToAnalyze = await this.getMaxFilesFromGlobalParameters();

        if (changedFiles?.length > maxFilesToAnalyze) {
            return {
                status: 'SKIP',
                loginfo: {
                    message: `PR#${pullRequest.number} has more than ${maxFilesToAnalyze} files, skipping`,
                    context: CodeReviewHandlerService.name,
                    metadata: {
                        organizationAndTeamData,
                        repository,
                        pullRequest,
                        branch,
                    },
                },
            };
        }

        return {
            status: 'CONTINUE',
            files: changedFiles,
            lastExecution: lastExecution
                ? {
                    commentId: lastExecution?.dataExecution?.commentId,
                    noteId: lastExecution?.dataExecution?.noteId,
                    lastAnalyzedCommit:
                        lastExecution?.dataExecution?.lastAnalyzedCommit,
                }
                : undefined,
        };
    }

    async getOrCreateInitialComment(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: any,
        repository: { name: string; id: string },
        filesResult: GetChangedFilesResult,
        codeReviewConfig: CodeReviewConfig,
        platformType: string,
    ): Promise<GetOrCreateInitialCommentResult> {
        if (
            filesResult.lastExecution?.commentId &&
            filesResult.lastExecution?.noteId
        ) {
            return {
                status: 'CONTINUE',
                data: {
                    commentId: filesResult.lastExecution.commentId,
                    noteId: filesResult.lastExecution.noteId,
                },
                loginfo: {
                    message: `Using existing comment for PR#${pullRequest.number}`,
                    context: CodeReviewHandlerService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber: pullRequest.number,
                        commentId: filesResult.lastExecution.commentId,
                        noteId: filesResult.lastExecution.noteId,
                    },
                },
            };
        }

        const result = await this.commentManagerService.createInitialComment(
            organizationAndTeamData,
            pullRequest.number,
            repository,
            filesResult.files,
            codeReviewConfig?.languageResultPrompt,
            platformType,
        );

        return { status: 'CONTINUE', data: result };
    }

    private async requestChangesIfCritical(
        isRequestChanges: boolean,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
        lineComments: CommentResult[],
    ) {
        try {
            if (!isRequestChanges) return;

            const criticalComments = lineComments.filter(
                (comment) =>
                    comment.comment.suggestion.severity ===
                    SeverityLevel.CRITICAL,
            );

            if (criticalComments.length <= 0) return;

            await this.codeManagementService.requestChangesPullRequest({
                organizationAndTeamData,
                prNumber,
                repository,
                criticalComments,
            });
        } catch (error) {
            this.logger.error({
                message: `Error when trying to change status to request changes for PR#${prNumber}`,
                error,
                context: CodeReviewHandlerService.name,
                metadata: {
                    isRequestChanges,
                    prNumber,
                    organizationAndTeamData,
                    repository,
                    lineComments,
                },
            });
        }
    }

    private async approvePullRequest(
        pullRequestApprovalActive: boolean,
        lineCommentsLength: number,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        repository: { id: string; name: string },
    ) {
        try {
            if (!pullRequestApprovalActive || lineCommentsLength > 0) return;

            const approved =
                await this.codeManagementService.approvePullRequest({
                    organizationAndTeamData,
                    prNumber,
                    repository,
                });

            return approved;
        } catch (error) {
            this.logger.error({
                message: `Error when trying to merge PR#${prNumber}`,
                error,
                context: CodeReviewHandlerService.name,
                metadata: { organizationAndTeamData, prNumber, repository },
            });
        }
    }

    async handlePullRequest(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: any,
        branch: string,
        pullRequest: any,
        platformType: string,
        teamAutomationId: string,
        origin: string,
        action: string,
    ) {
        try {
            const initialContext: CodeReviewPipelineContext = {
                status: PipelineStatus.RUN,
                pipelineVersion: '1.0.0',
                errors: [],
                organizationAndTeamData,
                repository,
                pullRequest,
                branch,
                teamAutomationId,
                origin,
                action,
                platformType: platformType as PlatformType,
                pipelineMetadata: {
                    lastExecution: null,
                },
                batches: [],
                preparedFileContexts: [],
                validSuggestions: [],
                discardedSuggestions: [],
                overallComments: [],
                lastAnalyzedCommit: null,
            };

            this.logger.log({
                message: `Iniciando pipeline de code review para PR#${pullRequest.number}`,
                context: CodeReviewHandlerService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    pullRequestNumber: pullRequest.number,
                },
            });

            const pipeline =
                this.pipelineFactory.getPipeline('CodeReviewPipeline');
            const result = await pipeline.execute(initialContext);

            this.logger.log({
                message: `Pipeline de code review concluído com sucesso para PR#${pullRequest.number}`,
                context: CodeReviewHandlerService.name,
                metadata: {
                    overallCommentsCount: result?.overallComments?.length,
                    suggestionsCount: result?.lineComments?.length || 0,
                },
            });

            return {
                overallComments: result?.overallComments,
                lastAnalyzedCommit: result?.lastAnalyzedCommit,
                commentId: result?.initialCommentData?.commentId,
                noteId: result?.initialCommentData?.noteId,
            };
        } catch (error) {
            this.logger.error({
                message: `Erro ao executar pipeline de code review para PR#${pullRequest.number}`,
                context: CodeReviewHandlerService.name,
                error,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    pullRequestNumber: pullRequest.number,
                },
            });

            return null;
        }
    }
    //#endregion

    //#region Generate and Update PR Summary
    async generateAndUpdatePRSummary(
        pullRequest: any,
        repository: any,
        overallComments: any,
        organizationAndTeamData: OrganizationAndTeamData,
        languageResultPrompt: any,
        summaryConfig: any,
    ) {
        const summaryPR = await this.commentManagerService.generateSummaryPR(
            pullRequest,
            repository,
            overallComments,
            organizationAndTeamData,
            languageResultPrompt,
            summaryConfig,
        );

        await this.commentManagerService.updateSummarizationInPR(
            organizationAndTeamData,
            pullRequest.number,
            repository,
            summaryPR,
        );
    }

    async updatePRComment(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequestNumber: number,
        repository: any,
        commentId: number,
        noteId: number,
        platformType: string,
    ) {
        await this.commentManagerService.updateOverallComment(
            organizationAndTeamData,
            pullRequestNumber,
            repository,
            commentId,
            noteId,
            platformType,
        );
    }

    async analyzeChangedFilesInBatches(
        context: AnalysisContext,
        changedFiles: FileChange[],
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<{
        overallComments: any[];
        lastAnalyzedCommit: any;
        lineComments: Array<CommentResult>;
    }> {
        const { organizationAndTeamData, pullRequest } = context;

        const label = `Total review pipeline for PR#${pullRequest.number}`;

        return benchmark(
            { label, metadata: context.organizationAndTeamData },
            this.logger,
            async () => {
                try {
                    this.logger.log({
                        message: `Starting batch analysis of ${changedFiles.length} files`,
                        context: CodeReviewHandlerService.name,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                            pullRequestNumber: pullRequest.number,
                        },
                    });

                    const batches = this.createOptimizedBatches(changedFiles);

                    const execution = await this.runBatches(
                        batches,
                        context,
                        clusterizedSuggestions,
                    );

                    this.logger.log({
                        message: `Finished all batches`,
                        context: CodeReviewHandlerService.name,
                        metadata: {
                            validSuggestionsCount:
                                execution.validSuggestions.length,
                            discardedCount:
                                execution.discardedSuggestions.length,
                        },
                    });

                    return await this.finalizeReviewProcessing(
                        context,
                        changedFiles,
                        execution.validSuggestions,
                        execution.discardedSuggestions,
                        execution.overallComments,
                    );
                } catch (error) {
                    this.logProcessingError(
                        error,
                        organizationAndTeamData,
                        pullRequest,
                    );
                    return this.createEmptyResult();
                }
            },
        );
    }

    private async runBatches(
        batches: FileChange[][],
        context: AnalysisContext,
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<{
        validSuggestions: Partial<CodeSuggestion>[];
        discardedSuggestions: Partial<CodeSuggestion>[];
        overallComments: { filepath: string; summary: string }[];
    }> {
        const validSuggestions: Partial<CodeSuggestion>[] = [];
        const discardedSuggestions: Partial<CodeSuggestion>[] = [];
        const overallComments: { filepath: string; summary: string }[] = [];

        await this.processBatchesSequentially(
            batches,
            context,
            validSuggestions,
            discardedSuggestions,
            overallComments,
            clusterizedSuggestions,
        );

        return {
            validSuggestions,
            discardedSuggestions,
            overallComments,
        };
    }

    /**
     * Creates optimized batches of files for parallel processing
     * @param files Array of files to be processed
     * @returns Array of file batches
     */
    private createOptimizedBatches(files: FileChange[]): FileChange[][] {
        const batches = createOptimizedBatches(files, {
            minBatchSize: 20,
            maxBatchSize: 30,
        });

        this.validateBatchIntegrity(batches, files.length);

        this.logger.log({
            message: `Processing ${files.length} files in ${batches.length} batches`,
            context: CodeReviewHandlerService.name,
        });

        return batches;
    }

    /**
     * Validates the integrity of the batches to ensure all files are processed
     * @param batches Batches created for processing
     * @param totalFileCount Original total number of files
     */
    private validateBatchIntegrity(
        batches: FileChange[][],
        totalFileCount: number,
    ): void {
        const totalFilesInBatches = batches.reduce(
            (sum, batch) => sum + batch.length,
            0,
        );
        if (totalFilesInBatches !== totalFileCount) {
            this.logger.warn({
                message: `Potential file processing mismatch! Total files: ${totalFileCount}, files in batches: ${totalFilesInBatches}`,
                context: CodeReviewHandlerService.name,
            });
            // Ensure all files are processed even in case of mismatch
            if (totalFilesInBatches < totalFileCount) {
                // If we identify that files might be missing, process all at once
                batches.length = 0;
                batches.push(Array.from({ length: totalFileCount }));
            }
        }
    }

    private async processBatchesSequentially(
        batches: FileChange[][],
        context: AnalysisContext,
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
        overallComments: { filepath: string; summary: string }[],
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<void> {
        for (const [index, batch] of batches.entries()) {
            this.logger.log({
                message: `Processing batch ${index + 1}/${batches.length} with ${batch.length} files`,
                context: CodeReviewHandlerService.name,
            });

            await this.processSingleBatch(
                batch,
                context,
                validSuggestionsToAnalyze,
                discardedSuggestionsBySafeGuard,
                overallComments,
                index,
                clusterizedSuggestions,
            );
        }
    }

    private async processSingleBatch(
        batch: FileChange[],
        context: AnalysisContext,
        validSuggestions: Partial<CodeSuggestion>[],
        discardedSuggestions: Partial<CodeSuggestion>[],
        overallComments: { filepath: string; summary: string }[],
        batchIndex: number,
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<void> {
        const { organizationAndTeamData, pullRequest } = context;
        const label = `processSingleBatch → Batch #${batchIndex + 1} (${batch.length} arquivos)`;

        await benchmark(
            { label, metadata: context.organizationAndTeamData },
            this.logger,
            async () => {
                const preparedFiles = await this.filterAndPrepareFiles(
                    batch,
                    context,
                );

                const results = await Promise.allSettled(
                    preparedFiles.map(({ fileContext }) =>
                        this.executeFileAnalysis(
                            fileContext,
                            clusterizedSuggestions,
                        ),
                    ),
                );

                results.forEach((result) => {
                    if (result.status === 'fulfilled') {
                        this.collectFileProcessingResult(
                            result.value,
                            validSuggestions,
                            discardedSuggestions,
                            overallComments,
                        );
                    } else {
                        this.logger.error({
                            message: `Error processing file in batch ${batchIndex + 1}`,
                            error: result.reason,
                            context: CodeReviewHandlerService.name,
                            metadata: {
                                organizationId:
                                    organizationAndTeamData.organizationId,
                                teamId: organizationAndTeamData.teamId,
                                pullRequestNumber: pullRequest.number,
                                batchIndex,
                            },
                        });
                    }
                });
            },
        );
    }

    /**
     * Collects and organizes the results of file processing
     * @param fileProcessingResult Result of the file processing
     * @param validSuggestionsToAnalyze Array to store the valid suggestions found
     * @param discardedSuggestionsBySafeGuard Array to store the discarded suggestions
     * @param overallComments Array to store the general comments
     */
    private collectFileProcessingResult(
        fileProcessingResult: IFinalAnalysisResult & { file: FileChange },
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
        overallComments: { filepath: string; summary: string }[],
    ): void {
        const file = fileProcessingResult.file;

        if (fileProcessingResult?.validSuggestionsToAnalyze?.length > 0) {
            validSuggestionsToAnalyze.push(
                ...fileProcessingResult.validSuggestionsToAnalyze,
            );
        }

        if (fileProcessingResult?.discardedSuggestionsBySafeGuard?.length > 0) {
            discardedSuggestionsBySafeGuard.push(
                ...fileProcessingResult.discardedSuggestionsBySafeGuard,
            );
        }

        if (fileProcessingResult?.overallComment?.summary) {
            overallComments.push(fileProcessingResult.overallComment);
        }

        // Update file metadata
        if (fileProcessingResult?.reviewMode) {
            file.reviewMode = fileProcessingResult.reviewMode;
        }

        if (fileProcessingResult?.codeReviewModelUsed) {
            file.codeReviewModelUsed = fileProcessingResult.codeReviewModelUsed;
        }
    }

    /**
     * Finalizes the code review process by generating comments and saving suggestions
     * @param organizationAndTeamData Organization and team data
     * @param pullRequest Pull request data
     * @param codeReviewConfig Code review configuration
     * @param repository Repository where the PR is located
     * @param platformType Platform type (e.g., GitHub, GitLab, etc.)
     * @param changedFiles Files changed in the PR
     * @param validSuggestionsToAnalyze Valid suggestions found
     * @param discardedSuggestionsBySafeGuard Discarded suggestions
     * @param overallComments General comments
     * @returns Processing result with comments and suggestions
     */
    private async finalizeReviewProcessing(
        context: AnalysisContext,
        changedFiles: FileChange[],
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[],
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[],
        overallComments: { filepath: string; summary: string }[],
    ): Promise<{
        overallComments: any[];
        lastAnalyzedCommit: any;
        lineComments: Array<CommentResult>;
    }> {
        const {
            organizationAndTeamData,
            pullRequest,
            codeReviewConfig,
            repository,
            platformType,
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
            platformType as PlatformType,
        );

        // Resolve comments that refer to suggestions partially or fully implemented
        await this.resolveCommentsWithImplementedSuggestions({
            organizationAndTeamData,
            repository,
            prNumber: pullRequest.number,
            platformType: platformType as PlatformType,
        });

        return {
            overallComments,
            lastAnalyzedCommit,
            lineComments: commentResults,
        };
    }

    /**
     * Logs processing errors
     * @param error The error that occurred
     * @param organizationAndTeamData Organization and team data
     * @param pullRequest Pull request data
     */
    private logProcessingError(
        error: any,
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
    ): void {
        this.logger.error({
            message: `Error in batch file processing`,
            error,
            context: CodeReviewHandlerService.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                pullRequestNumber: pullRequest.number,
            },
        });
    }

    /**
     * Creates an empty result for error cases
     * @returns Empty result object
     */
    private createEmptyResult(): {
        overallComments: any[];
        lastAnalyzedCommit: any;
        lineComments: Array<CommentResult>;
    } {
        return {
            overallComments: [],
            lastAnalyzedCommit: null,
            lineComments: [],
        };
    }

    private async executeFileAnalysis(
        baseContext: AnalysisContext,
        clusterizedSuggestions: IClusterizedSuggestion[],
    ): Promise<IFinalAnalysisResult & { file: FileChange }> {
        const { reviewModeResponse } = baseContext;
        const { file, patchWithLinesStr } = baseContext.fileChangeContext;

        try {
            const context: AnalysisContext = {
                ...baseContext,
                reviewModeResponse: reviewModeResponse,
                fileChangeContext: { file, patchWithLinesStr },
            };

            const standardAnalysisResult =
                await this.codeAnalysisOrchestrator.executeStandardAnalysis(
                    context.organizationAndTeamData,
                    context.pullRequest.number,
                    { file, patchWithLinesStr },
                    reviewModeResponse,
                    context,
                );

            const finalResult = await this.processAnalysisResult(
                standardAnalysisResult,
                context,
                clusterizedSuggestions,
            );

            return { ...finalResult, file };
        } catch (error) {
            this.logger.error({
                message: `Error analyzing file ${file.filename}`,
                error,
                context: CodeReviewHandlerService.name,
                metadata: {
                    filename: file.filename,
                    organizationId:
                        baseContext.organizationAndTeamData.organizationId,
                    teamId: baseContext.organizationAndTeamData.teamId,
                    pullRequestNumber: baseContext.pullRequest.number,
                },
            });

            return {
                validSuggestionsToAnalyze: [],
                discardedSuggestionsBySafeGuard: [],
                overallComment: { filepath: file.filename, summary: '' },
                file,
            };
        }
    }

    private async filterAndPrepareFiles(
        batch: FileChange[],
        context: AnalysisContext,
    ): Promise<Array<{ fileContext: AnalysisContext }>> {
        const limit = pLimit(this.concurrencyLimit);

        const settledResults = await Promise.allSettled(
            batch.map((file) =>
                limit(() =>
                    this.fileReviewContextPreparation.prepareFileContext(
                        file,
                        context,
                    ),
                ),
            ),
        );

        settledResults?.forEach((res, index) => {
            if (res.status === 'rejected') {
                this.logger.error({
                    message: `Error preparing the file "${batch[index]?.filename}" for analysis`,
                    error: res.reason,
                    context: CodeReviewHandlerService.name,
                    metadata: {
                        ...context.organizationAndTeamData,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });
            }
        });

        return settledResults
            ?.filter(
                (
                    res,
                ): res is PromiseFulfilledResult<{
                    fileContext: AnalysisContext;
                }> => res.status === 'fulfilled' && res.value !== null,
            )
            ?.map((res) => res.value);
    }

    private async getMaxFilesFromGlobalParameters(): Promise<number> {
        const globalParameter = await this.globalParametersService.findByKey(
            GlobalParametersKey.CODE_REVIEW_MAX_FILES,
        );

        return globalParameter
            ? parseInt(globalParameter?.configValue)
            : this.max_files_to_analyze;
    }
}
