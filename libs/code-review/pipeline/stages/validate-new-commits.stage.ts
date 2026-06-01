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
import { createLogger } from '@kodus/flow';
import {
    AutomationMessage,
    AutomationStatus,
} from '@libs/automation/domain/automation/enum/automation-status';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { IStageValidationResult } from '@libs/core/infrastructure/pipeline/interfaces/stage-result.interface';
import { PipelineReasons } from '@libs/core/infrastructure/pipeline/constants/pipeline-reasons.const';
import { StageMessageHelper } from '@libs/core/infrastructure/pipeline/utils/stage-message.helper';

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
        const allCommits =
            await this.pullRequestHandlerService.getNewCommitsSinceLastExecution(
                context.organizationAndTeamData,
                context.repository,
                context.pullRequest,
            );

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
                // (rebase or force-push rewrote history). Falling back to a
                // full review is the only safe option — using compare(orphan, head)
                // would return diff lines that came from the target branch via
                // rebase, and Kody would comment on code the author never wrote.
                forceFullRerun = true;
                if (lastExecutionResult) {
                    lastExecutionResult.lastAnalyzedCommit = undefined;
                }
                orphanedBaseCommit = {
                    previousSha: lastCommitSha,
                    currentHeadSha: context.pullRequest.head?.sha,
                    totalCommits: allCommits.length,
                };
                this.logger.warn({
                    message: `Orphaned base commit detected for PR#${context.pullRequest.number} — falling back to full review`,
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
