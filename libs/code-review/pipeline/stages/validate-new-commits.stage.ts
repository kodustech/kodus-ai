import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { Inject, Injectable } from '@nestjs/common';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { createLogger } from '@libs/core/log/logger';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IStageValidationResult } from '@libs/core/infrastructure/pipeline/interfaces/stage-result.interface';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';
import { is429Error } from '@libs/core/infrastructure/http/rate-limit-retry';

@Injectable()
export class ValidateNewCommitsStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'ValidateNewCommitsStage';
    readonly label = 'Checking Commits';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(ValidateNewCommitsStage.name);
    private readonly rerunEligibleStageNames = [
        'PRLevelReviewStage',
        'FileAnalysisStage',
    ];
    private readonly rerunEligibleStatuses = [
        AutomationStatus.PARTIAL_ERROR,
        AutomationStatus.ERROR,
    ];

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: IPullRequestManagerService,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const lastExecution =
            await this.automationExecutionService.findLatestExecutionByFilters({
                status: AutomationStatus.SUCCESS,
                teamAutomation: { uuid: context.teamAutomationId },
                pullRequestNumber: context.pullRequest.number,
                repositoryId: context?.repository?.id,
            });

        let lastAnalyzedCommit: string | undefined;
        let lastExecutionResult: any;
        let forceFullRerun = false;
        let orphanedBaseCommit: CodeReviewPipelineContext['orphanedBaseCommit'];
        let rebaseInterdiffFiles: FileChange[] | undefined;

        if (lastExecution?.dataExecution?.lastAnalyzedCommit) {
            lastAnalyzedCommit = lastExecution.dataExecution.lastAnalyzedCommit;
            lastExecutionResult = {
                commentId: lastExecution?.dataExecution?.commentId,
                noteId: lastExecution?.dataExecution?.noteId,
                threadId: lastExecution?.dataExecution?.threadId,
                lastAnalyzedCommit: lastAnalyzedCommit,
            };

            this.logger.log({
                message: `Found last analyzed commit: ${JSON.stringify(lastAnalyzedCommit)}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                    pullRequestNumber: context.pullRequest.number,
                },
            });

            forceFullRerun = await this.shouldForceFullRerun(
                context,
                lastExecution.uuid,
            );
        } else {
            this.logger.log({
                message: 'No last analyzed commit found, analyzing all commits',
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                    pullRequestNumber: context.pullRequest.number,
                },
            });
        }

        // Buscar TODOS os commits do PR
        let allCommits: Commit[];
        try {
            allCommits =
                await this.pullRequestHandlerService.getNewCommitsSinceLastExecution(
                    context.organizationAndTeamData,
                    context.repository,
                    context.pullRequest,
                );
        } catch (error) {
            if (!is429Error(error)) {
                throw error;
            }

            this.logger.warn({
                message: `Skipping code review for PR#${context.pullRequest.number} — provider rate-limited the commit fetch (HTTP 429)`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                    pullRequestNumber: context.pullRequest.number,
                    reason: 'provider_rate_limited',
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.COMMITS.PROVIDER_RATE_LIMITED,
                        'Provider rate-limited the commit fetch (HTTP 429)',
                    ),
                };
            });
        }

        // Filtrar commits novos localmente (após lastAnalyzedCommit)
        let newCommits = allCommits || [];
        const lastCommitSha =
            typeof lastAnalyzedCommit === 'string'
                ? lastAnalyzedCommit
                : (lastAnalyzedCommit as Commit)?.sha;

        if (lastCommitSha && allCommits?.length > 0) {
            const lastCommitIndex = allCommits.findIndex(
                (commit) => commit.sha === lastCommitSha,
            );
            if (lastCommitIndex !== -1) {
                newCommits = allCommits.slice(lastCommitIndex + 1);
            } else {
                // Base commit is no longer reachable from the PR branch
                // (rebase or force-push rewrote history). compare(orphan, head)
                // would return lines that came from the target branch via the
                // rebase, so what is new is read by comparing the PR diff at
                // the orphan with the current one (#2037). When that diff
                // can't be read, the whole PR is reviewed again.
                if (lastExecutionResult) {
                    lastExecutionResult.lastAnalyzedCommit = undefined;
                }
                orphanedBaseCommit = {
                    previousSha: lastCommitSha,
                    currentHeadSha: context.pullRequest.head?.sha,
                    totalCommits: allCommits.length,
                };
                this.logger.warn({
                    message: `Orphaned base commit detected for PR#${context.pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repository: context.repository.name,
                        pullRequestNumber: context.pullRequest.number,
                        orphanedSha: lastCommitSha,
                        currentHeadSha: context.pullRequest.head?.sha,
                        totalCommits: allCommits.length,
                        reason: 'orphaned_base_commit',
                    },
                });

                // `--force` and `-v <agent>` ask for the whole PR.
                let interdiff: Awaited<
                    ReturnType<IPullRequestManagerService['getRebaseInterdiff']>
                > = null;
                try {
                    interdiff = forceFullRerun
                        ? null
                        : await this.pullRequestHandlerService.getRebaseInterdiff(
                              context.organizationAndTeamData,
                              context.repository,
                              context.pullRequest,
                              lastCommitSha,
                          );
                } catch (error) {
                    // A full review would hit the throttled host harder; skip
                    // like a rate-limited commit fetch does.
                    if (!is429Error(error)) throw error;
                    this.logger.warn({
                        message: `Skipping code review for PR#${context.pullRequest.number} — provider rate-limited the diff fetch (HTTP 429)`,
                        context: this.stageName,
                        metadata: {
                            organizationAndTeamData:
                                context.organizationAndTeamData,
                            repository: context.repository.name,
                            pullRequestNumber: context.pullRequest.number,
                            orphanedSha: lastCommitSha,
                            reason: 'provider_rate_limited',
                        },
                    });
                    return this.updateContext(context, (draft) => {
                        draft.statusInfo = {
                            status: AutomationStatus.SKIPPED,
                            message: StageMessageHelper.skippedWithReason(
                                PipelineReasons.COMMITS.PROVIDER_RATE_LIMITED,
                                'Provider rate-limited the diff fetch (HTTP 429)',
                            ),
                        };
                    });
                }

                if (forceFullRerun) {
                    orphanedBaseCommit.interdiff = {
                        fallback: 'full_review_requested',
                    };
                } else if (!interdiff) {
                    forceFullRerun = true;
                    orphanedBaseCommit.interdiff = {
                        fallback: 'previous_diff_unavailable',
                    };
                } else {
                    rebaseInterdiffFiles = interdiff.files;
                    orphanedBaseCommit.interdiff = {
                        filesToReview: interdiff.files.length,
                        unchangedFiles: interdiff.unchangedFiles.length,
                        partialFiles: interdiff.partialFiles.length,
                        uncomparedFiles: interdiff.uncomparedFiles.length,
                        hunksKept: interdiff.hunksKept,
                        hunksDropped: interdiff.hunksDropped,
                    };
                }

                this.logger.log({
                    message: forceFullRerun
                        ? `Rebase of PR#${context.pullRequest.number}: reviewing the whole PR`
                        : `Rebase of PR#${context.pullRequest.number}: ${rebaseInterdiffFiles.length} file(s) changed since the last review`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        repository: context.repository.name,
                        pullRequestNumber: context.pullRequest.number,
                        orphanedSha: lastCommitSha,
                        currentHeadSha: context.pullRequest.head?.sha,
                        interdiff: orphanedBaseCommit.interdiff,
                        unchangedFiles: interdiff?.unchangedFiles,
                        partialFiles: interdiff?.partialFiles,
                        uncomparedFiles: interdiff?.uncomparedFiles,
                        reason: 'rebase_interdiff',
                    },
                });

                if (rebaseInterdiffFiles && !rebaseInterdiffFiles.length) {
                    return this.updateContext(context, (draft) => {
                        draft.statusInfo = {
                            status: AutomationStatus.SKIPPED,
                            message: StageMessageHelper.skippedWithReason(
                                PipelineReasons.COMMITS.REBASE_NO_CHANGES,
                                'The rebase changed nothing since the last review',
                            ),
                        };
                        draft.prAllCommits = allCommits;
                        if (lastExecutionResult) {
                            draft.lastExecution = lastExecutionResult;
                        }
                        draft.orphanedBaseCommit = orphanedBaseCommit;
                        draft.pipelineMetadata = {
                            ...draft.pipelineMetadata,
                            forceFullRerun: false,
                        };
                    });
                }
            }
        }

        const validationResult = this.validateCommits(
            context,
            newCommits,
            allCommits || [],
            lastCommitSha,
        );

        if (!validationResult.canProceed) {
            const details = validationResult.details;
            const message = details?.message || 'Skipped validation';
            const reasonCode =
                details?.reasonCode ||
                AutomationMessage.NO_NEW_COMMITS_SINCE_LAST;

            this.logger.warn({
                message: `Skipping code review for PR#${context.pullRequest.number} - ${message}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                    pullRequestNumber: context.pullRequest.number,
                    reason: details?.technicalReason,
                    metadata: details?.metadata,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.statusInfo = {
                    status: AutomationStatus.SKIPPED,
                    message: reasonCode,
                };

                // Use the pre-formatted message from details if available
                draft.statusInfo.message = message;

                draft.prAllCommits = allCommits;
                if (lastExecutionResult) {
                    draft.lastExecution = lastExecutionResult;
                }
                draft.pipelineMetadata = {
                    ...draft.pipelineMetadata,
                    forceFullRerun: false,
                };
            });
        }

        this.logger.log({
            message: `Processing ${newCommits.length} new commits for PR#${context.pullRequest.number} (${allCommits?.length} total)`,
            context: this.stageName,
            metadata: {
                organizationAndTeamData: context.organizationAndTeamData,
                repository: context.repository.name,
                pullRequestNumber: context.pullRequest.number,
            },
        });

        return this.updateContext(context, (draft) => {
            draft.prCommits = newCommits;
            draft.prAllCommits = allCommits;
            if (lastExecutionResult) {
                draft.lastExecution = lastExecutionResult;
            }
            if (orphanedBaseCommit) {
                draft.orphanedBaseCommit = orphanedBaseCommit;
            }
            if (rebaseInterdiffFiles) {
                draft.rebaseInterdiffFiles = rebaseInterdiffFiles;
            }
            draft.pipelineMetadata = {
                ...draft.pipelineMetadata,
                forceFullRerun,
            };
        });
    }

    private async shouldForceFullRerun(
        context: CodeReviewPipelineContext,
        lastExecutionId: string,
    ): Promise<boolean> {
        // `@kody review --force` (origin = 'command-force') always forces a
        // full re-review regardless of the previous execution's status. This
        // is the whole point of the flag — let customers re-run a successful
        // (or apparently successful but empty) review after fixing whatever
        // upstream issue invalidated it. Without this the bypass in
        // validateCommits() lets the pipeline run, but newCommits ends up
        // empty and the agent has nothing to analyze.
        // `@kody -v <agent>` asks one custom agent to review the whole PR,
        // not only what changed since the last review.
        if (context.onlyCustomAgent) {
            return true;
        }

        if (context.origin === 'command-force') {
            this.logger.log({
                message: `Forcing full re-review for PR#${context.pullRequest.number} via --force flag`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                    pullRequestNumber: context.pullRequest.number,
                    lastExecutionId,
                    origin: context.origin,
                },
            });
            return true;
        }

        // Plain `@kody review` (origin = 'command') only forces a full re-run
        // when the previous execution failed at a rerun-eligible stage —
        // preserves the incremental-review behavior for the common case.
        if (context.origin !== 'command') {
            return false;
        }

        const shouldForce =
            await this.automationExecutionService.hasStageWithStatus(
                lastExecutionId,
                this.rerunEligibleStageNames,
                this.rerunEligibleStatuses,
            );

        if (shouldForce) {
            this.logger.log({
                message: `Forcing full re-review for PR#${context.pullRequest.number} due to previous partial/error analysis`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: context.repository.name,
                    pullRequestNumber: context.pullRequest.number,
                    lastExecutionId,
                    stageNames: this.rerunEligibleStageNames,
                },
            });
        }

        return shouldForce;
    }

    private validateCommits(
        context: CodeReviewPipelineContext,
        newCommits: Commit[],
        allCommits: Commit[],
        lastAnalyzedCommitSha?: string,
    ): IStageValidationResult {
        // 1. Force Re-review (Manual). Both 'command' (plain @kody review)
        //    and 'command-force' (@kody review --force) bypass the
        //    no-new-commits guard — the latter is what lets customers
        //    re-run a review after fixing whatever broke the previous one.
        if (context.origin?.startsWith('command')) {
            return {
                canProceed: true,
                details: {
                    message: 'Proceeding due to manual re-review request',
                    reasonCode: AutomationMessage.PROCESSING_MANUAL,
                },
            };
        }

        // 2. No commits found at all
        if (!allCommits || allCommits.length === 0) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.COMMITS.NO_NEW,
                        'PR has 0 commits',
                    ),
                    technicalReason: 'PR has 0 commits',
                    reasonCode: AutomationMessage.NO_NEW_COMMITS_SINCE_LAST,
                },
            };
        }

        // 3. No new commits found
        if (!newCommits || newCommits.length === 0) {
            const headSha = context.pullRequest.head?.sha || 'unknown';
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.COMMITS.NO_NEW,
                        'No changes detected since last review',
                    ),
                    technicalReason: 'No changes detected since last review',
                    reasonCode: AutomationMessage.NO_NEW_COMMITS_SINCE_LAST,
                    metadata: {
                        totalCommits: allCommits.length,
                        lastAnalyzedCommit: lastAnalyzedCommitSha,
                        headSha,
                    },
                },
            };
        }

        // 4. Only merge commits found
        const isOnlyMerge = this.checkIfOnlyMergeCommits(newCommits);
        if (isOnlyMerge) {
            return {
                canProceed: false,
                details: {
                    message: StageMessageHelper.skippedWithReason(
                        PipelineReasons.COMMITS.ONLY_MERGE,
                        'All new commits identified as merge commits',
                    ),
                    technicalReason:
                        'All new commits identified as merge commits',
                    reasonCode: AutomationMessage.ONLY_MERGE_COMMITS_SINCE_LAST,
                },
            };
        }

        return { canProceed: true };
    }

    private checkIfOnlyMergeCommits(commits: Commit[]): boolean {
        const mergeCommits = commits.filter(
            (commit) => commit.parents?.length > 1,
        );

        if (mergeCommits.length === 0) {
            return false;
        }

        const allNewCommitShas = new Set(commits.map((c) => c.sha));
        const commitMap = new Map(commits.map((c) => [c.sha, c]));
        const mergedCommitTracker = new Set<string>();
        const stack: string[] = [];

        for (const commit of mergeCommits) {
            mergedCommitTracker.add(commit.sha);
            for (let i = 1; i < (commit.parents?.length || 0); i++) {
                const parentSha = commit.parents[i]?.sha;
                if (parentSha) {
                    stack.push(parentSha);
                }
            }
        }

        while (stack.length > 0) {
            const sha = stack.pop();
            if (
                !sha ||
                !allNewCommitShas.has(sha) ||
                mergedCommitTracker.has(sha)
            ) {
                continue;
            }

            mergedCommitTracker.add(sha);
            const commit = commitMap.get(sha);
            if (!commit || !commit.parents || commit.parents.length === 0) {
                continue;
            }

            commit.parents.forEach((parent) => {
                if (parent.sha) {
                    stack.push(parent.sha);
                }
            });
        }

        return mergedCommitTracker.size === allNewCommitShas.size;
    }
}
