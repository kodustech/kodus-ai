import { Injectable } from '@nestjs/common';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import type { BusinessValidationOutcome } from '@libs/agents/business-validation/business-validation.types';
import { formatPullRequestDiff } from '@libs/agents/business-validation/pull-request-diff';
import { RERUN_COMMAND } from '@libs/agents/business-validation/render';
import {
    type BusinessLogicConfig,
    resolveBusinessLogicSettings,
} from '@libs/agents/business-validation/settings';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { createLogger } from '@libs/core/log/logger';
import { BusinessLogicPublisher } from '@libs/platform/application/services/business-logic-publisher.service';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Checks the PR against the task it references, through BusinessValidationService,
 * and puts the outcome on the PR through BusinessLogicPublisher.
 *
 * The review posts only what the author can act on: the verdict, a task too
 * thin to judge, or a reference that looks like a typo. Everything else (no
 * task referenced, a tracker that can't read it, a tracker that is down) is
 * silent on the PR: the check says "skipped" and the run records why.
 *
 * Automatic validation runs on the first review, or on every push when the
 * team turned that on. `@kody -v business-logic` and `@kody review --force`
 * re-run it on demand. A re-run edits the same comment.
 */
@Injectable()
export class BusinessLogicValidationStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(BusinessLogicValidationStage.name);
    readonly stageName = 'BusinessLogicValidationStage';
    readonly label = 'Validating Business Logic';
    readonly visibility = StageVisibility.PRIMARY;
    readonly errorSeverity = 'partial' as const;

    private static readonly TIMEOUT_MS = 300_000; // 5 min

    constructor(
        private readonly businessValidationService: BusinessValidationService,
        private readonly publisher: BusinessLogicPublisher,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // IMPORTANT: do NOT mutate context.statusInfo from this stage. The
        // executor treats SKIPPED as "abort the pipeline"; the outcome travels
        // in businessLogicOutcome instead.
        const skip = this.evaluateSkip(context);
        if (skip) {
            return this.skipped(context, skip.reason, skip.message);
        }

        const explicitRun = context.origin === 'command-force';
        const settings = this.settingsOf(context);
        const rerun = !explicitRun && this.wasAlreadyValidated(context);
        try {
            const request = {
                door: explicitRun ? ('force' as const) : ('auto' as const),
                organizationAndTeamData: context.organizationAndTeamData,
                repository: {
                    id: String(context.repository.id),
                    name: context.repository.name,
                    fullName: context.repository.fullName,
                },
                pullRequest: {
                    number: context.pullRequest.number,
                    title: context.pullRequest.title,
                    body: context.pullRequest.body,
                    headRef: context.pullRequest.head?.ref,
                    baseRef: context.pullRequest.base?.ref,
                },
                platformType: context.platformType,
                diff: formatPullRequestDiff(context.changedFiles),
                // Per-repo/directory model override resolved by ValidateConfigStage.
                byokModel: context.codeReviewConfig?.byokModel,
                byokModelId: context.codeReviewConfig?.byokModelId,
                settings,
            };
            const result = await this.withTimeout(
                this.businessValidationService.validate(request),
            );
            const published = await this.publisher.publish({
                request,
                result,
                settings,
                headSha: context.pullRequest.head?.sha,
                trigger: explicitRun ? 'force' : rerun ? 'push' : 'auto',
                commits: (context.prAllCommits ?? context.prCommits ?? []).map(
                    (c) => ({
                        message: c.commit?.message ?? '',
                        authorName: c.commit?.author?.name,
                        authorEmail: c.commit?.author?.email,
                    }),
                ),
                authorLogin: context.pullRequest.user?.login,
            });
            return this.applyOutcome(context, published.outcome);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.logger.error({
                message: `[BUSINESS-LOGIC] Validation failed for PR#${context.pullRequest?.number}: ${message}`,
                context: this.stageName,
                error,
            });
            const pipelineError: PipelineError = {
                stage: this.stageName,
                substage: 'BusinessValidationService',
                error: error instanceof Error ? error : new Error(message),
                metadata: { prNumber: context.pullRequest?.number },
            };
            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.errors.push(pipelineError);
                draft.businessLogicOutcome = {
                    kind: 'error',
                    message: `Business logic validation failed: ${message}`,
                };
            });
        }
    }

    private settingsOf(context: CodeReviewPipelineContext) {
        return resolveBusinessLogicSettings(
            (
                context.codeReviewConfig as {
                    businessLogic?: BusinessLogicConfig;
                }
            )?.businessLogic,
        );
    }

    /** The outcome as the review records it. The PR comment and check were already written. */
    private applyOutcome(
        context: CodeReviewPipelineContext,
        outcome: BusinessValidationOutcome,
    ): CodeReviewPipelineContext {
        if (outcome.kind === 'skipped') {
            return this.skipped(
                context,
                outcome.reason,
                `Skipped: ${outcome.reason.replace(/_/g, ' ')}.`,
            );
        }
        const validatedAt = new Date().toISOString();
        return this.updateContext(context, (draft) => {
            draft.businessLogicResults = [];
            draft.businessLogicValidatedAt = validatedAt;
            switch (outcome.kind) {
                case 'task_too_thin':
                    draft.businessLogicOutcome = {
                        kind: 'skipped',
                        reason: 'weak_task_context',
                        message: `Skipped: ${outcome.tasks.map((t) => t.id).join(', ')} has too little to validate against.`,
                    };
                    break;
                case 'task_missing':
                    draft.businessLogicOutcome = {
                        kind: 'skipped',
                        reason: 'task_missing',
                        message: `Skipped: ${outcome.references.map((r) => r.raw).join(', ')} doesn't exist in ${outcome.tracker}.`,
                    };
                    break;
                case 'validated': {
                    // The verdict decides; the report's wording never does (#2019).
                    const ids = outcome.checks.map((c) => c.task.id).join(', ');
                    draft.businessLogicOutcome = outcome.passed
                        ? { kind: 'success', message: `PR aligns with ${ids}.` }
                        : {
                              kind: 'gap_found',
                              message:
                                  'Business logic gap detected — see PR-level comment.',
                          };
                    break;
                }
            }
        });
    }

    private evaluateSkip(
        context: CodeReviewPipelineContext,
    ): { reason: string; message: string } | null {
        if (!context?.organizationAndTeamData) {
            return {
                reason: 'missing_org',
                message: 'Missing organization context.',
            };
        }
        if (!context?.pullRequest?.number) {
            return {
                reason: 'missing_pr',
                message: 'Missing pull request data.',
            };
        }
        if (!context?.repository?.id) {
            return {
                reason: 'missing_repo',
                message: 'Missing repository data.',
            };
        }
        if (!context.codeReviewConfig?.reviewOptions?.business_logic) {
            return {
                reason: 'option_off',
                message:
                    'Business logic validation is disabled in the code review configuration.',
            };
        }
        // `@kody review --force`, or a team that asked for a re-check on every
        // push, revalidates a PR that already got a message. `forceFullRerun`
        // is NOT that signal: a force-push and a retried partial review both
        // set it.
        if (
            context.origin !== 'command-force' &&
            !this.settingsOf(context).recheckOnPush &&
            this.wasAlreadyValidated(context)
        ) {
            return {
                reason: 'already_validated',
                message: `Skipped: business logic was already validated for this pull request. Run \`${RERUN_COMMAND}\` to validate it again.`,
            };
        }
        return null;
    }

    /**
     * Validation is one-shot per PR. Releases before this recorded a hash of
     * the PR body instead; any such hash counts as "already validated".
     */
    private wasAlreadyValidated(context: CodeReviewPipelineContext): boolean {
        const lastExecution = context.pipelineMetadata?.lastExecution as
            | { businessLogicValidatedAt?: string; businessLogicHash?: string }
            | undefined;
        return Boolean(
            lastExecution?.businessLogicValidatedAt ||
            lastExecution?.businessLogicHash,
        );
    }

    private skipped(
        context: CodeReviewPipelineContext,
        reason: string,
        message: string,
    ): CodeReviewPipelineContext {
        this.logger.log({
            message: `[BUSINESS-LOGIC] Skipped: ${message}`,
            context: this.stageName,
            metadata: {
                organizationId: context.organizationAndTeamData?.organizationId,
                prNumber: context.pullRequest?.number,
                reason,
            },
        });
        return this.updateContext(context, (draft) => {
            draft.businessLogicResults = [];
            draft.businessLogicOutcome = { kind: 'skipped', reason, message };
        });
    }

    private async withTimeout<T>(promise: Promise<T>): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('BusinessLogicValidation timeout')),
                BusinessLogicValidationStage.TIMEOUT_MS,
            );
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }
}
