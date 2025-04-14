import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';

import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import { PinoLoggerService } from '../../../logger/pino.service';
import {
    AIAnalysisResult,
    AnalysisContext,
    ClusteringType,
    CodeReviewConfig,
    CodeSuggestion,
    CommentResult,
    FileChange,
    IFinalAnalysisResult,
    Repository,
} from '@/config/types/general/codeReview.type';
import { benchmark } from '@/shared/utils/benchmark.util';
import { createOptimizedBatches } from '@/shared/utils/batch.helper';
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
import {
    FILE_REVIEW_CONTEXT_PREPARATION_TOKEN,
    IFileReviewContextPreparation,
} from '@/shared/interfaces/file-review-context-preparation.interface';
import { CodeManagementService } from '../../../platformIntegration/codeManagement.service';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { AutomationStatus } from '@/core/domain/automation/enums/automation-status';
import { AutomationExecutionEntity } from '@/core/domain/automation/entities/automation-execution.entity';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@/core/domain/automation/contracts/automation-execution.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    IKodyFineTuningContextPreparationService,
    KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN,
} from '@/shared/interfaces/kody-fine-tuning-context-preparation.interface';
import {
    IKodyASTAnalyzeContextPreparationService,
    KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN,
} from '@/shared/interfaces/kody-ast-analyze-context-preparation.interface';
import { CodeAnalysisOrchestrator } from '@/ee/codeBase/codeAnalysisOrchestrator.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestsEntity } from '@/core/domain/pullRequests/entities/pullRequests.entity';
import { PullRequestReviewComment } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';

@Injectable()
export class ProcessFilesReview extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'FileAnalysisStage';

    private readonly concurrencyLimit = 10;

    private fileMetadata: Map<string, any> = new Map();

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestService: IPullRequestsService,

        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,

        @Inject(FILE_REVIEW_CONTEXT_PREPARATION_TOKEN)
        private readonly fileReviewContextPreparation: IFileReviewContextPreparation,

        @Inject(KODY_FINE_TUNING_CONTEXT_PREPARATION_TOKEN)
        private readonly kodyFineTuningContextPreparation: IKodyFineTuningContextPreparationService,

        @Inject(KODY_AST_ANALYZE_CONTEXT_PREPARATION_TOKEN)
        private readonly kodyAstAnalyzeContextPreparation: IKodyASTAnalyzeContextPreparationService,

        private readonly codeAnalysisOrchestrator: CodeAnalysisOrchestrator,

        private readonly codeManagementService: CodeManagementService,
        private logger: PinoLoggerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.changedFiles || context.changedFiles.length === 0) {
            this.logger.warn({
                message: `No files to analyze for PR#${context.pullRequest.number}`,
                context: this.stageName,
            });
            return context;
        }

        try {
            const { overallComments, lastAnalyzedCommit, lineComments } =
                await this.analyzeChangedFilesInBatches(context);

            return this.updateContext(context, (draft) => {
                draft.overallComments = overallComments;
                draft.lastAnalyzedCommit = lastAnalyzedCommit;
                draft.lineComments = lineComments;
            });
        } catch (error) {
            this.logger.error({
                message: 'Error analyzing files in batches',
                error,
                context: this.stageName,
                metadata: {
                    pullRequestNumber: context.pullRequest.number,
                    repositoryName: context.repository.name,
                    batchCount: context.batches.length,
                },
            });

            // Mesmo em caso de erro, retornamos o contexto para que o pipeline continue
            return this.updateContext(context, (draft) => {
                draft.overallComments = [];
                draft.lastAnalyzedCommit = null;
                draft.lineComments = [];
            });
        }
    }

    async analyzeChangedFilesInBatches(
        context: CodeReviewPipelineContext,
    ): Promise<{
        overallComments: any[];
        lastAnalyzedCommit: any;
        lineComments: Array<CommentResult>;
    }> {
        const { organizationAndTeamData, pullRequest, changedFiles } = context;
        const analysisContext =
            this.createAnalysisContextFromPipelineContext(context);

        const label = `Total review pipeline for PR#${pullRequest.number}`;

        return benchmark(
            { label, metadata: context.organizationAndTeamData },
            this.logger,
            async () => {
                try {
                    this.logger.log({
                        message: `Starting batch analysis of ${changedFiles.length} files`,
                        context: ProcessFilesReview.name,
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
                        analysisContext,
                    );

                    this.logger.log({
                        message: `Finished all batches`,
                        context: ProcessFilesReview.name,
                        metadata: {
                            validSuggestionsCount:
                                execution.validSuggestions.length,
                            discardedCount:
                                execution.discardedSuggestions.length,
                        },
                    });

                    return await this.finalizeReviewProcessing(
                        analysisContext,
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
            context: ProcessFilesReview.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                pullRequestNumber: pullRequest.number,
            },
        });
    }

    private async runBatches(
        batches: FileChange[][],
        context: AnalysisContext,
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
            context: ProcessFilesReview.name,
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
                context: ProcessFilesReview.name,
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
    ): Promise<void> {
        for (const [index, batch] of batches.entries()) {
            this.logger.log({
                message: `Processing batch ${index + 1}/${batches.length} with ${batch.length} files`,
                context: ProcessFilesReview.name,
            });

            try {
                await this.processSingleBatch(
                    batch,
                    context,
                    validSuggestionsToAnalyze,
                    discardedSuggestionsBySafeGuard,
                    overallComments,
                    index,
                );
            } catch (error) {
                this.logger.error({
                    message: `Error processing batch ${index + 1}`,
                    error,
                    context: ProcessFilesReview.name,
                    metadata: {
                        batchIndex: index,
                        batchSize: batch.length,
                        pullRequestNumber: context.pullRequest.number,
                    },
                });
                // Continuamos processando os próximos lotes mesmo se um falhar
            }
        }
    }

    private async processSingleBatch(
        batch: FileChange[],
        context: AnalysisContext,
        validSuggestions: Partial<CodeSuggestion>[],
        discardedSuggestions: Partial<CodeSuggestion>[],
        overallComments: { filepath: string; summary: string }[],
        batchIndex: number,
    ): Promise<void> {
        const { organizationAndTeamData, pullRequest } = context;
        const label = `processSingleBatch → Batch #${batchIndex + 1} (${batch.length} arquivos)`;

        await benchmark(
            { label, metadata: context.organizationAndTeamData },
            this.logger,
            async () => {
                // TESTAR
                const preparedFiles = await this.filterAndPrepareFiles(
                    batch,
                    context,
                );

                const results = await Promise.allSettled(
                    preparedFiles.map(({ fileContext }) =>
                        this.executeFileAnalysis(fileContext),
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
                            context: ProcessFilesReview.name,
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

        if (fileProcessingResult?.file?.filename) {
            this.fileMetadata.set(fileProcessingResult.file.filename, {
                reviewMode: fileProcessingResult.reviewMode,
                codeReviewModelUsed: fileProcessingResult.codeReviewModelUsed,
            });
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
            platformType,
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
                context: ProcessFilesReview.name,
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

    private async savePullRequestSuggestions(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: { number: number },
        repository: Partial<Repository>,
        changedFiles: FileChange[],
        commentResults: CommentResult[],
        sortedPrioritizedSuggestions: Partial<CodeSuggestion>[],
        discardedSuggestions: Partial<CodeSuggestion>[],
        platformType: string,
    ) {
        const enrichedFiles = changedFiles.map((file) => {
            const metadata = this.fileMetadata.get(file.filename);
            if (metadata) {
                return {
                    ...file,
                    reviewMode: metadata.reviewMode,
                    codeReviewModelUsed: metadata.codeReviewModelUsed,
                };
            }
            return file;
        });

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
            organizationAndTeamData?.organizationId,
            pullRequestCommits,
        );
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
                    context: ProcessFilesReview.name,
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

    private async executeFileAnalysis(
        baseContext: AnalysisContext,
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

            const kodyRulesSuggestions =
                await this.codeAnalysisOrchestrator.executeKodyRulesAnalysis(
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                    { file, patchWithLinesStr },
                    context,
                    {
                        overallSummary: standardAnalysisResult?.overallSummary,
                        codeSuggestions:
                            standardAnalysisResult?.codeSuggestions,
                    },
                );

            const finalResult = await this.processAnalysisResult(
                standardAnalysisResult,
                context,
                kodyRulesSuggestions,
            );

            return { ...finalResult, file };
        } catch (error) {
            this.logger.error({
                message: `Error analyzing file ${file.filename}`,
                error,
                context: ProcessFilesReview.name,
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

    private async processAnalysisResult(
        result: AIAnalysisResult,
        context: AnalysisContext,
        kodyRulesSuggestions: any,
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

            const getDataPipelineKodyFineTunning =
                await this.kodyFineTuningContextPreparation.prepareKodyFineTuningContext(
                    context?.organizationAndTeamData.organizationId,
                    context?.pullRequest?.number,
                    {
                        id: context?.pullRequest?.repository?.id || '',
                        full_name:
                            context?.pullRequest?.repository?.fullName || '',
                    },
                    suggestionsWithId,
                    context?.codeReviewConfig?.kodyFineTuningConfig?.enabled,
                );

            discardedSuggestionsByKodyFineTuning.push(
                ...getDataPipelineKodyFineTunning.discardedSuggestions.map(
                    (suggestion) => {
                        suggestion.priorityStatus =
                            PriorityStatus.DISCARDED_BY_KODY_FINE_TUNING;
                        return suggestion;
                    },
                ),
            );

            const safeGuardResponse =
                await this.suggestionService.filterSuggestionsSafeGuard(
                    context?.organizationAndTeamData,
                    context?.pullRequest?.number,
                    file,
                    patchWithLinesStr,
                    getDataPipelineKodyFineTunning?.keepedSuggestions ??
                    suggestionsWithId,
                    context?.codeReviewConfig?.languageResultPrompt,
                    reviewModeResponse,
                );

            safeguardLLMProvider =
                safeGuardResponse?.codeReviewModelUsed?.safeguard;

            discardedSuggestionsBySafeGuard.push(
                ...this.suggestionService.getDiscardedSuggestions(
                    getDataPipelineKodyFineTunning?.keepedSuggestions ??
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
                    safeGuardResponse?.suggestions ?? suggestionsWithId,
                    context?.codeReviewConfig?.reviewOptions,
                );

            let mergedSuggestions = [];

            // Se tem sugestões do Kody Rules, adiciona
            if (kodyRulesSuggestions?.codeSuggestions?.length > 0) {
                mergedSuggestions.push(...kodyRulesSuggestions.codeSuggestions);
            }

            // Se tem sugestões com severidade, adiciona também
            if (suggestionsWithSeverity?.length > 0) {
                mergedSuggestions.push(...suggestionsWithSeverity);
            }

            // TESTAR
            const kodyASTSuggestions =
                await this.kodyAstAnalyzeContextPreparation.prepareKodyASTAnalyzeContext(
                    context,
                );

            mergedSuggestions = [
                ...mergedSuggestions,
                ...(kodyASTSuggestions?.codeSuggestions || []),
            ];

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

    private async addSuggestionsId(suggestions: any[]): Promise<any[]> {
        return suggestions?.map((suggestion) => ({
            ...suggestion,
            id: uuidv4(),
        }));
    }

    private createAnalysisContextFromPipelineContext(
        context: CodeReviewPipelineContext,
    ): AnalysisContext {
        return {
            organizationAndTeamData: context.organizationAndTeamData,
            repository: context.repository,
            pullRequest: context.pullRequest,
            action: context.action,
            platformType: context.platformType,
            codeReviewConfig: context.codeReviewConfig,
            codeAnalysisAST: context.codeAnalysisAST,
            clusterizedSuggestions: context.clusterizedSuggestions,
        };
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

            // timeout mechanism for the Promise.allSettled operation to prevent potential hanging.
            await Promise.race([
                Promise.allSettled(promises),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timed out')), 30000))
            ]);
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
