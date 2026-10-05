import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { BusinessValidationService } from '@libs/agents/business-validation/business-validation.service';
import type { BusinessValidationOutcome } from '@libs/agents/business-validation/business-validation.types';
import { resolveValidationStatus } from '@libs/agents/business-validation/judge/validation-verdict';
import { formatPullRequestDiff } from '@libs/agents/business-validation/pull-request-diff';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { createLogger } from '@libs/core/log/logger';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Checks the PR against the task it references, through BusinessValidationService.
 *
 * The review posts only what the author can act on: the verdict, or a task
 * too thin to judge. Everything else (no task referenced, a tracker that
 * can't read it, a tracker that is down) is silent on the PR and recorded as
 * the stage's outcome.
 *
 * Automatic validation is one-shot per pull request. Later pushes stay silent;
 * `@kody -v business-logic` and `@kody review --force` re-run it on demand.
 */
@Injectable()
export class BusinessLogicValidationStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(BusinessLogicValidationStage.name);
    readonly stageName = 'BusinessLogicValidationStage';
    readonly label = 'Validating Business Logic';
    readonly visibility = StageVisibility.PRIMARY;
    readonly errorSeverity = 'partial' as const;

    private static readonly TIMEOUT_MS = 300_000; // 5 min

    /** Command that re-runs the validation on demand. Matches the handler in
     *  ChatWithKodyFromGitUseCase — keep the two in sync. */
    private static readonly RERUN_COMMAND = '@kody -v business-logic';

    constructor(
        private readonly businessValidationService: BusinessValidationService,
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
        try {
            const result = await this.withTimeout(
                this.businessValidationService.validate({
                    door: explicitRun ? 'force' : 'auto',
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
                }),
            );
            return this.applyOutcome(context, result.outcome, explicitRun);
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

    private applyOutcome(
        context: CodeReviewPipelineContext,
        outcome: BusinessValidationOutcome,
        explicitRun: boolean,
    ): CodeReviewPipelineContext {
        const validatedAt = new Date().toISOString();

        if (outcome.kind === 'skipped') {
            return this.skipped(
                context,
                outcome.reason,
                `Skipped: ${outcome.reason.replace(/_/g, ' ')}.`,
            );
        }

        if (outcome.kind === 'task_too_thin') {
            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [
                    this.suggestion(
                        this.withRerunHint(outcome.message, explicitRun),
                        `${outcome.task.id} says too little to validate against.`,
                        SeverityLevel.MEDIUM,
                    ),
                ];
                draft.businessLogicValidatedAt = validatedAt;
                draft.businessLogicOutcome = {
                    kind: 'skipped',
                    reason: 'weak_task_context',
                    message: `Skipped: ${outcome.task.id} has too little to validate against.`,
                };
            });
        }

        // The verdict decides; the report's wording never does (#2019).
        const compliant =
            resolveValidationStatus(outcome.verdict) === 'compliant';
        return this.updateContext(context, (draft) => {
            draft.businessLogicResults = [
                this.suggestion(
                    this.withRerunHint(outcome.report, explicitRun),
                    compliant
                        ? 'Business logic validation passed — PR aligns with task requirements.'
                        : 'Business logic gap detected based on PR requirements.',
                    compliant ? SeverityLevel.LOW : SeverityLevel.MEDIUM,
                ),
            ];
            draft.businessLogicValidatedAt = validatedAt;
            draft.businessLogicOutcome = compliant
                ? {
                      kind: 'success',
                      message: `PR aligns with ${outcome.task.id}.`,
                  }
                : {
                      kind: 'gap_found',
                      message:
                          'Business logic gap detected — see PR-level comment.',
                  };
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
        // `@kody review --force` is the only automatic path that revalidates a
        // PR that already got a message. `forceFullRerun` is NOT that signal:
        // a force-push and a retried partial review both set it.
        if (
            context.origin !== 'command-force' &&
            this.wasAlreadyValidated(context)
        ) {
            return {
                reason: 'already_validated',
                message: `Skipped: business logic was already validated for this pull request. Run \`${BusinessLogicValidationStage.RERUN_COMMAND}\` to validate it again.`,
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

    private suggestion(
        content: string,
        summary: string,
        severity: SeverityLevel,
    ): ISuggestionByPR {
        return {
            id: uuidv4(),
            suggestionContent: content,
            oneSentenceSummary: summary,
            label: LabelType.BUSINESS_LOGIC,
            severity,
            deliveryStatus: DeliveryStatus.NOT_SENT,
        };
    }

    private withRerunHint(result: string, explicitRun: boolean): string {
        if (explicitRun) {
            return result;
        }
        return `${result}\n\n---\n> 💡 This validation runs automatically only on the first review of a pull request. To run it again, comment \`${BusinessLogicValidationStage.RERUN_COMMAND}\`.`;
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
