import { Inject, Injectable } from '@nestjs/common';
import { BasePipelineStage } from '../../../pipeline/base-stage.abstract';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@/core/domain/codeBase/contracts/PullRequestManagerService.contract';
import {
    ICommentManagerService,
    COMMENT_MANAGER_SERVICE_TOKEN,
} from '@/core/domain/codeBase/contracts/CommentManagerService.contract';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PinoLoggerService } from '../../../logger/pino.service';
import {
    handlePatchDeletions,
    convertToHunksWithLinesNumbers,
} from '@/shared/utils/patch';
import { FileChange } from '@/config/types/general/codeReview.type';
import {
    AutomationMessage,
    AutomationStatus,
} from '@/core/domain/automation/enums/automation-status';

@Injectable()
export class FetchChangedFilesStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'FetchChangedFilesStage';

    private maxFilesToAnalyze = 500;

    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private pullRequestHandlerService: IPullRequestManagerService,
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private commentManagerService: ICommentManagerService,
        private logger: PinoLoggerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!context.codeReviewConfig) {
            this.logger.error({
                message: 'No config found in context',
                context: this.stageName,
                metadata: {
                    prNumber: context?.pullRequest?.number,
                    repositoryName: context?.repository?.name,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: AutomationMessage.NO_CONFIG_IN_CONTEXT,
                };
            });
        }

        const files = await this.pullRequestHandlerService.getChangedFiles(
            context.organizationAndTeamData,
            context.repository,
            context.pullRequest,
            context.codeReviewConfig.ignorePaths,
            context?.lastExecution?.lastAnalyzedCommit,
        );

        if (!files?.length || files.length > this.maxFilesToAnalyze) {
            const msg = !files?.length
                ? AutomationMessage.NO_FILES_AFTER_IGNORE
                : AutomationMessage.TOO_MANY_FILES;

            if (!files?.length && context.lastExecution) {
                await this.commentManagerService.createNoChangesComment(
                    context.organizationAndTeamData,
                    context.pullRequest.number,
                    context.repository,
                    context.platformType,
                    context.codeReviewConfig?.languageResultPrompt ?? 'en-US',
                    context.dryRun,
                );
            }

            this.logger.warn({
                message: `Skipping code review for PR#${context.pullRequest.number} - ${msg}`,
                context: FetchChangedFilesStage.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    filesCount: files?.length || 0,
                    ignorePaths: context.codeReviewConfig.ignorePaths,
                },
            });
            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: msg,
                };
            });
        }

        this.logger.log({
            message: `Found ${files.length} files to analyze for PR#${context.pullRequest.number}`,
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository.name,
                pullRequestNumber: context.pullRequest.number,
                filesCount: files.length,
            },
        });

        const filesWithLineNumbers = this.prepareFilesWithLineNumbers(files);

        const stats = this.getStatsForPR(filesWithLineNumbers);

        return this.updateContext(context, (draft) => {
            draft.changedFiles = filesWithLineNumbers;
            draft.pipelineMetadata = {
                ...draft.pipelineMetadata,
            };
            draft.pullRequest.stats = stats;
        });
    }

    private prepareFilesWithLineNumbers(files: FileChange[]): FileChange[] {
        if (!files?.length || files?.length === 0) {
            return [];
        }

        return files?.map((file) => {
            try {
                if (!file?.patch) {
                    return file;
                }

                const patchFormatted = handlePatchDeletions(
                    file.patch,
                    file.filename,
                    file.status,
                );

                if (!patchFormatted) {
                    return file;
                }

                const patchWithLinesStr = convertToHunksWithLinesNumbers(
                    patchFormatted,
                    file,
                );

                return {
                    ...file,
                    patchWithLinesStr,
                };
            } catch (error) {
                this.logger.error({
                    message: `Error preparing line numbers for file "${file?.filename}"`,
                    error,
                    context: FetchChangedFilesStage.name,
                    metadata: {
                        filename: file?.filename,
                    },
                });
                return file;
            }
        });
    }

    private getStatsForPR(
        files: FileChange[],
    ): CodeReviewPipelineContext['pullRequest']['stats'] {
        let totalAdditions = 0;
        let totalDeletions = 0;

        files.forEach((file) => {
            totalAdditions += file.additions || 0;
            totalDeletions += file.deletions || 0;
        });

        return {
            total_additions: totalAdditions,
            total_deletions: totalDeletions,
            total_files: files.length,
            total_lines_changed: totalAdditions + totalDeletions,
        };
    }
}
