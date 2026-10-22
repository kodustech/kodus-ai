import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { ignoredFilesForCustomAgents } from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import {
    convertToUnifiedDiffWithLineNumbers,
    handlePatchDeletions,
} from '@libs/common/utils/patch';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { IStageValidationResult } from '@libs/core/infrastructure/pipeline/interfaces/stage-result.interface';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class FetchChangedFilesStage extends BasePipelineStage<CodeReviewPipelineContext> {
    stageName = 'FetchChangedFilesStage';
    readonly visibility = StageVisibility.PRIMARY;
    readonly label = 'Loading Files Context';

    private readonly logger = createLogger(FetchChangedFilesStage.name);
    /** Hard ceiling for the legacy engine (no chunking).
     *  Lowered from 500 → 350 after the 2026-05-13 rate-limit incident:
     *  PRs in the 351-500 range hit GitHub /contents once per file with
     *  no shared cache, dominating quota during commercial hours. The
     *  agent engine (with sandbox) doesn't suffer from this and keeps
     *  its higher ceiling. */
    private static readonly LEGACY_MAX_FILES = 350;
    /** Higher ceiling for the agent engine, which chunks by token budget.
     *  Still bounded to prevent abuse (huge auto-generated PRs). */
    private static readonly AGENT_MAX_FILES = 2000;

    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private pullRequestHandlerService: IPullRequestManagerService,
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

        // Reutilizar arquivos do ResolveConfigStage se disponíveis, caso contrário buscar
        let filesToProcess = context.preliminaryFiles;
        const forceFullRerun = Boolean(
            context.pipelineMetadata?.forceFullRerun,
        );
        const baseCommit = forceFullRerun
            ? undefined
            : context?.lastExecution?.lastAnalyzedCommit;

        if (!filesToProcess || filesToProcess.length === 0) {
            this.logger.log({
                message: `No preliminary files in context, fetching from API for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                },
            });

            filesToProcess =
                await this.pullRequestHandlerService.getChangedFilesMetadata(
                    context.organizationAndTeamData,
                    context.repository,
                    context.pullRequest,
                    baseCommit,
                );
        }

        const ignorePaths = context.codeReviewConfig.ignorePaths || [];
        const filteredFiles =
            filesToProcess?.filter(
                (file) =>
                    file.status !== 'removed' &&
                    !isFileMatchingGlob(file.filename, ignorePaths),
            ) || [];
        const ignoredList =
            filesToProcess?.filter(
                (file) =>
                    file.status === 'removed' ||
                    isFileMatchingGlob(file.filename, ignorePaths),
            ) || [];
        const filesToAnalyze = filteredFiles;
        // Ignored files a custom agent still reviews (#2172): they keep a
        // review alive on their own and count toward its ceiling.
        const filesForCustomAgents = ignoredFilesForCustomAgents(
            context,
            ignoredList,
        );

        const validation = this.validateFiles(
            filesToProcess,
            filesToAnalyze,
            filesForCustomAgents,
            ignorePaths,
            FetchChangedFilesStage.AGENT_MAX_FILES,
        );

        if (!validation.canProceed) {
            const { message, technicalReason, metadata } =
                validation.details || {};

            this.logger.warn({
                message: `Skipping code review for PR#${context.pullRequest.number} - ${message}`,
                context: FetchChangedFilesStage.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    filesCount: filesToAnalyze?.length || 0,
                    totalFilesBeforeFilter: filesToProcess?.length || 0,
                    ignorePaths,
                    technicalReason,
                    ...metadata,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: message,
                };
                draft.ignoredFiles = ignoredList?.map((f) => f.filename) || [];
                draft.ignoredFileChanges =
                    ignoredList?.filter((f) => f.status !== 'removed') || [];
            });
        }

        this.logger.log({
            message: `Found ${filesToAnalyze.length} files to analyze for PR#${context.pullRequest.number} (${filesToProcess?.length || 0} total, ${(filesToProcess?.length || 0) - filteredFiles.length} ignored)`,
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository.name,
                pullRequestNumber: context.pullRequest.number,
                filesCount: filesToAnalyze.length,
                totalFilesBeforeFilter: filesToProcess?.length || 0,
                ignoredFilesCount:
                    (filesToProcess?.length || 0) - filteredFiles.length,
            },
        });

        // Buscar conteúdo apenas dos arquivos filtrados (não ignorados)
        const filesWithContent =
            await this.pullRequestHandlerService.enrichFilesWithContent(
                context.organizationAndTeamData,
                context.repository,
                context.pullRequest,
                filesToAnalyze,
            );

        const filesWithLineNumbers =
            this.prepareFilesWithLineNumbers(filesWithContent);

        const stats = this.getStatsForPR(filesWithLineNumbers);

        const ignoredFileChanges = await this.withContentForCustomAgents(
            context,
            ignoredList?.filter((f) => f.status !== 'removed') || [],
            filesForCustomAgents,
        );

        return this.updateContext(context, (draft) => {
            draft.changedFiles = filesWithLineNumbers;
            draft.pullRequest.stats = stats;
            draft.ignoredFiles = ignoredList?.map((f) => f.filename) || [];
            draft.ignoredFileChanges = ignoredFileChanges;
        });
    }

    /**
     * A custom agent reviews an ignored file one of its include globs names
     * explicitly (#2172), so those files get content and line numbers as the
     * reviewed ones do; the rest stay as listed. Without such an agent
     * nothing more is fetched.
     */
    private async withContentForCustomAgents(
        context: CodeReviewPipelineContext,
        ignoredFileChanges: FileChange[],
        named: FileChange[],
    ): Promise<FileChange[]> {
        if (!named.length) {
            return ignoredFileChanges;
        }
        const enriched = new Map(
            this.prepareFilesWithLineNumbers(
                await this.pullRequestHandlerService.enrichFilesWithContent(
                    context.organizationAndTeamData,
                    context.repository,
                    context.pullRequest,
                    named,
                ),
            ).map((file) => [file.filename, file]),
        );
        return ignoredFileChanges.map(
            (file) => enriched.get(file.filename) ?? file,
        );
    }

    private validateFiles(
        filesToProcess: FileChange[],
        filteredFiles: FileChange[],
        filesForCustomAgents: FileChange[],
        ignorePaths: string[],
        maxFilesToAnalyze: number,
    ): IStageValidationResult {
        if (!filesToProcess || filesToProcess.length === 0) {
            return {
                canProceed: false,
                details: {
                    reasonCode: AutomationMessage.NO_FILES_IN_PR,
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.FILES.NO_CHANGES,
                    ),
                },
            };
        }

        if (!filteredFiles?.length && !filesForCustomAgents.length) {
            const ignoredFileNames = filesToProcess.map((f) => f.filename);
            const messageFiles = ignoredFileNames.slice(0, 5).join(', ');
            const suffix = ignoredFileNames.length > 5 ? '...' : '';

            return {
                canProceed: false,
                details: {
                    reasonCode: AutomationMessage.NO_FILES_AFTER_IGNORE,
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.FILES.ALL_IGNORED,
                        `Ignored: ${messageFiles}${suffix}`,
                    ),
                    technicalReason: `Ignored files: ${ignoredFileNames.join(', ')}`,
                    metadata: { ignorePaths, ignoredFiles: ignoredFileNames },
                },
            };
        }

        const count = filteredFiles.length + filesForCustomAgents.length;
        if (count > maxFilesToAnalyze) {
            return {
                canProceed: false,
                details: {
                    reasonCode: AutomationMessage.TOO_MANY_FILES,
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.FILES.TOO_MANY,
                        `Count: ${count}, Limit: ${maxFilesToAnalyze}`,
                    ),
                    technicalReason: `Count: ${count}, Limit: ${maxFilesToAnalyze}`,
                    metadata: {
                        count,
                        limit: maxFilesToAnalyze,
                    },
                },
            };
        }

        return { canProceed: true };
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

                const patchWithLinesStr = convertToUnifiedDiffWithLineNumbers(
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
