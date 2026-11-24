import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { Injectable, Logger } from '@nestjs/common';

import {
    PR_DECISION_RECONCILER_ENABLED,
    PrDecisionReconcilerService,
} from '../services/pr-decision-reconciler.service';
import type { ReconcilerTrigger } from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';

/**
 * Pipeline stage wrapper around the per-PR reconciler service. Per
 * `tasks.md §4.2`, this stage is **disabled by default** — the existing
 * two-cron halves continue to govern until the rollout flag flips.
 *
 * The stage samples the verdicts the pipeline already produced and hands
 * them to the reconciler:
 *   - L0 from the PR's shape (draft, bot author)
 *   - L1 from `kodus-graph analyze` over the sandbox (needs the sandbox,
 *     which the pipeline created in `CreateSandboxStage`)
 *   - L2 from `context.riskAssessment` (`AssessPrRiskStage`)
 *   - L3 from `context.approvalDecision` (`DecidePrApprovalStage`)
 *
 * The stage runs between `DecidePrApprovalStage` and
 * `RequestChangesOrApproveStage`: after the decision inputs exist, before
 * the existing stage writes to the host — so the reconciler owns the host
 * projection when the flag is on, and the existing stage still owns it when
 * the flag is off.
 */
@Injectable()
export class PrDecisionReconcilerStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'PrDecisionReconcilerStage';
    readonly label = 'Reconciling PR decision';
    readonly visibility = StageVisibility.SECONDARY;
    readonly errorSeverity = 'partial' as const;

    private readonly logger = new Logger(PrDecisionReconcilerStage.name);

    constructor(private readonly reconciler: PrDecisionReconcilerService) {
        super();
    }

    public override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        if (!process.env[PR_DECISION_RECONCILER_ENABLED]) {
            this.logger.debug?.({
                message:
                    '[PR_DECISION_RECONCILER_ENABLED] off — stage passes through',
                context: PrDecisionReconcilerStage.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                },
            });
            return context;
        }

        const trigger = this.buildTrigger(context);
        if (!trigger) {
            this.logger.debug?.({
                message: '[PR_DECISION] no PR trigger context — skipping',
                context: PrDecisionReconcilerStage.name,
                metadata: {},
            });
            return context;
        }
        const outcome = await this.reconciler.reconcile(trigger);

        // The context is frozen (immer's `produce`), so the outcome is
        // attached through `updateContext` rather than by assignment.
        return this.updateContext(context, (draft) => {
            draft.prDecisionReconcileOutcome = outcome;
        });
    }

    private isBotAuthor(context: CodeReviewPipelineContext): boolean {
        const author = (context.pullRequest as any)?.author;
        const login: string | undefined =
            typeof author === 'string' ? author : author?.login;
        if (!login) return false;
        return /\[bot\]$/i.test(login);
    }

    private buildTrigger(
        context: CodeReviewPipelineContext,
    ): ReconcilerTrigger | null {
        const orgId = context.organizationAndTeamData?.organizationId;
        const repoId = context.repository?.id;
        const pr = context.pullRequest;
        if (!orgId || !repoId || !pr) return null;
        const headSha = pr.head?.sha ?? '';
        const baseSha = pr.base?.sha ?? '';
        if (!headSha || !baseSha) return null;
        return {
            organizationId: orgId,
            repositoryId: repoId,
            prNumber: pr.number ?? 0,
            headSha,
            baseSha,
            snapshotKey: this.snapshotKey(context, headSha),
            kind: 'commit-pushed',
            triggeredAt: new Date().toISOString(),
            // The gate inputs travel ON the trigger: the reconciler may run
            // for several PRs concurrently in one worker process, so a
            // module-level holder would let one PR read another PR's verdict.
            gates: {
                riskAssessment: context.riskAssessment ?? null,
                approvalDecision: context.approvalDecision ?? null,
                platform: context.platformType ?? '',
                prShape: {
                    isDraft: pr.isDraft === true,
                    isBotAuthor: this.isBotAuthor(context),
                },
                // L1 analyzes the PR's changed source files. Prefer the full
                // PR diff (what the risk engine uses); fall back to the
                // incremental set. An empty list here makes L1 report
                // "no changed source files" and the graph gate never runs.
                changedFiles: (context.fullPrFiles ?? context.changedFiles ?? [])
                    .filter((f) => typeof f.filename === 'string')
                    .map((f) => ({ filename: f.filename, status: f.status })),
                sandbox: context.sandboxHandle ?? null,
                host: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repository: {
                        id: context.repository?.id,
                        name: context.repository?.name,
                    },
                },
            },
        };
    }

    /**
     * The snapshot key identifies the configuration the verdicts were taken
     * under. Per `design.md §Decision 2` the key covers the snapshot-key
     * fields (`riskCriteria`, `approvalPolicies`,
     * `FilesRequiringHumanApproval`) plus the head SHA, so a configuration
     * edit changes the key and every verdict taken under the old one becomes
     * `Stale`.
     */
    private snapshotKey(
        context: CodeReviewPipelineContext,
        headSha: string,
    ): string {
        const config = context.codeReviewConfig as any;
        const fingerprint = JSON.stringify({
            riskCriteria: config?.riskCriteria ?? [],
            approvalPolicies: config?.approvalPolicies ?? [],
            approvalSensitivePaths: config?.approvalSensitivePaths ?? [],
            filesRequiringHumanApproval:
                config?.filesRequiringHumanApproval ?? [],
        });
        // A short, stable digest: the key is stored in the per-PR record and
        // read by the audit panel, so it must be short and must not leak the
        // configuration itself.
        let hash = 0;
        for (let i = 0; i < fingerprint.length; i++) {
            hash = (hash * 31 + fingerprint.charCodeAt(i)) | 0;
        }
        return `cfg=${(hash >>> 0).toString(16)};head=${headSha.slice(0, 7)}`;
    }
}
