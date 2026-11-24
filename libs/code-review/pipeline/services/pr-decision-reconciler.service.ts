import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { applyDesiredHostState } from '@libs/code-review/domain/risk/pr-decision-applier';
import {
    reduce,
    type DesiredHostState,
} from '@libs/code-review/domain/risk/pr-decision-reducer';

import {
    DECISION_RECORDER_TOKEN,
    HOST_DRIVER_TOKEN,
    L0_ASSESSOR_TOKEN,
    L1_ASSESSOR_TOKEN,
    L2_ASSESSOR_TOKEN,
    L3_ASSESSOR_TOKEN,
    type IDecisionRecorder,
    type L0Assessor,
    type L0AssessInput,
    type L1Assessor,
    type L1AssessInput,
    type L2Assessor,
    type L2AssessInput,
    type L3Assessor,
    type L3AssessInput,
    type ReconcileOutcome,
    type ReconcilerTrigger,
} from '@libs/code-review/domain/contracts/pr-decision-reconciler.ports';
import type { HostDriver } from '@libs/code-review/domain/risk/pr-decision-applier';
// A VALUE import, not `import type`: Nest reads the constructor parameter's
// runtime type to inject the repository, and a type-only import is erased
// at compile time, leaving the parameter undefined at runtime.
import { PrDecisionRecordRepository } from '@libs/code-review/infrastructure/adapters/repositories/prDecisionRecord.repository';

/**
 * The PR_DECISION_RECONCILER_ENABLED gate. Failing closed (per the spec;
 * absent the redeployer, the existing two-cron halves continue to govern).
 */
export const PR_DECISION_RECONCILER_ENABLED = 'PR_DECISION_RECONCILER_ENABLED';

/**
 * Refusal-retry policy. Per design.md §Decision 7 the safety-net poll is
 * a debounced fallback; the runtime backlog uses exponential backoff with
 * a per-PR key. The reconciler reads the latest refusal under its trigger
 * acceptance check (see `triggerAcceptance`).
 */
export const REFUSAL_BACKOFF_MS = 60_000;
export const REFUSAL_BACKOFF_MAX_MS = 30 * 60_000;
export const REFUSAL_BACKOFF_MULTIPLIER = 2;

/**
 * The reconciler. Run inside a single trigger; one record per
 * `(repo, pr, head)`. Per design.md §Decision 1, the trigger acceptance
 * check collapses bursts of triggers for the same head_sha into the
 * next reconciliation rather than starting two in parallel.
 *
 * Composition per design.md:
 *   gate verdicts → reducer → desiredHostState → applier → recorded delivery
 */
@Injectable()
export class PrDecisionReconcilerService {
    private readonly logger = new Logger(PrDecisionReconcilerService.name);

    constructor(
        @Inject(L0_ASSESSOR_TOKEN)
        private readonly l0: L0Assessor,
        @Inject(L1_ASSESSOR_TOKEN)
        private readonly l1: L1Assessor,
        @Inject(L2_ASSESSOR_TOKEN)
        private readonly l2: L2Assessor,
        @Inject(L3_ASSESSOR_TOKEN)
        private readonly l3: L3Assessor,
        private readonly recordRepo: PrDecisionRecordRepository,
        @Inject(HOST_DRIVER_TOKEN)
        private readonly hostDriver: HostDriver,
        @Optional()
        @Inject(DECISION_RECORDER_TOKEN)
        private readonly recorder?: IDecisionRecorder,
    ) {}

    /**
     * Run a single reconciliation pass for a trigger. Returns the outcome
     * so the stage can persist the result and the cron can record delivery.
     */
    async reconcile(trigger: ReconcilerTrigger): Promise<ReconcileOutcome> {
        const acceptance = await this.triggerAcceptance(trigger);
        if (acceptance.accepted === false) {
            return {
                record: {
                    organizationId: trigger.organizationId,
                    repositoryId: trigger.repositoryId,
                    prNumber: trigger.prNumber,
                    headSha: trigger.headSha,
                    baseSha: trigger.baseSha,
                    configurationKey: trigger.snapshotKey,
                },
                desired: {
                    kind: 'HOLD',
                    reason: acceptance.reason,
                    vetoSources: ['stale-snapshot'],
                },
                apply: {
                    status: 'aborted',
                    reason: 'prior-reconciliation-running',
                    priorReconciledAt: acceptance.priorReconciledAt,
                },
                recordedAt: new Date().toISOString(),
            };
        }

        const l0Verdict = await this.l0.assess(this.buildL0Input(trigger));
        const l1Verdict = await this.l1.assess(this.buildL1Input(trigger));
        const l2Verdict = await this.l2.assess(this.buildL2Input(trigger));
        const l3Verdict = await this.l3.assess(this.buildL3Input(trigger));

        const desiredState = reduce({
            snapshotKey: trigger.snapshotKey,
            l0: l0Verdict,
            l1: l1Verdict,
            l2: l2Verdict,
            l3: l3Verdict,
        });

        const recordRow = await this.recordRepo.upsert({
            organizationId: trigger.organizationId,
            repositoryId: trigger.repositoryId,
            prNumber: trigger.prNumber,
            headSha: trigger.headSha,
            baseSha: trigger.baseSha,
            configurationKey: trigger.snapshotKey,
            gateVerdictsSnapshot: {
                snapshotKey: trigger.snapshotKey,
                capturedAt: new Date().toISOString(),
                l0: l0Verdict as unknown,
                l1: l1Verdict as unknown,
                l2: l2Verdict as unknown,
                l3: l3Verdict as unknown,
            },
            lastApplyOutcome: {
                kind: 'skipped-nochange',
                steps: [],
                decidedAt: new Date().toISOString(),
            },
            lastReconciledAt: new Date(),
            consecutiveFailures: 0,
            inFlightTriggerKind: trigger.kind,
        });

        this.logger.debug?.({
            message: `[pr-decision] reconcile head=${trigger.headSha.slice(0, 8)} -> desired=${desiredState.kind}`,
            context: PrDecisionReconcilerService.name,
            metadata: {
                organizationId: trigger.organizationId,
                repositoryId: trigger.repositoryId,
                prNumber: trigger.prNumber,
            },
        });

        const applied = await applyDesiredHostState(
            desiredState,
            {
                repoId: trigger.repositoryId,
                prNumber: trigger.prNumber,
                headSha: trigger.headSha,
                snapshotKey: trigger.snapshotKey,
                priorChangeRequestActive: acceptance.priorChangeRequestActive,
                host: trigger.gates.host,
            },
            this.hostDriver,
        );

        const finalSteps: ReadonlyArray<{
            step: 'dismiss' | 'approve' | 'upsertComment';
            result: { status: 'ok' | 'retry' | 'fatal'; reason?: string };
        }> =
            applied.kind === 'skipped-nochange'
                ? []
                : applied.steps.map((s) => ({
                      step: s.step,
                      result: {
                          status:
                              s.result.status === 'ok'
                                  ? 'ok'
                                  : s.result.status === 'fatal'
                                    ? 'fatal'
                                    : 'retry',
                          ...(s.result.status !== 'ok' && s.result.reason
                              ? { reason: s.result.reason }
                              : {}),
                      },
                  }));

        await this.recordRepo.upsert({
            organizationId: trigger.organizationId,
            repositoryId: trigger.repositoryId,
            prNumber: trigger.prNumber,
            headSha: trigger.headSha,
            baseSha: trigger.baseSha,
            configurationKey: trigger.snapshotKey,
            gateVerdictsSnapshot: recordRow.gateVerdictsSnapshot,
            lastApplyOutcome: {
                kind: applied.kind === 'applied' ? 'applied' : 'partial',
                steps: finalSteps,
                decidedAt: new Date().toISOString(),
            },
            lastReconciledAt: new Date(),
            consecutiveFailures: applied.kind === 'applied' ? 0 : 1,
            inFlightTriggerKind: null,
        });

        // Outbox: record one row per apply transition. `notAfter` declines
        // for late hold posts; approves ignore `notAfter` (always recorded).
        // The cron posts are squashed onto a single comment via lookup,
        // same semantics as today's `recordApprovalReasonDelivery`.
        if (this.recorder) {
            const occurredAt = new Date().toISOString();
            await this.recorder.record({
                organizationId: trigger.organizationId,
                repositoryId: trigger.repositoryId,
                prNumber: trigger.prNumber,
                headSha: trigger.headSha,
                baseSha: trigger.baseSha,
                decision: desiredState.kind === 'APPROVE' ? 'approve' : 'hold',
                reason: desiredState.reason,
                occurredAt,
                notAfter:
                    desiredState.kind === 'HOLD'
                        ? new Date(Date.now() + 5 * 60_000).toISOString()
                        : undefined,
            });
        }

        return {
            record: {
                organizationId: trigger.organizationId,
                repositoryId: trigger.repositoryId,
                prNumber: trigger.prNumber,
                headSha: trigger.headSha,
                baseSha: trigger.baseSha,
                configurationKey: trigger.snapshotKey,
            },
            desired: toDesiredSummary(desiredState),
            apply:
                applied.kind === 'applied'
                    ? { status: 'applied' }
                    : {
                          status: 'partial',
                          attemptedSteps: applied.steps.map((s) => s.step),
                          reason: 'host-call failed',
                      },
            recordedAt: new Date().toISOString(),
        };
    }

    /**
     * Trigger acceptance check per `design.md §Decision 7`: a new trigger
     * whose `triggeredAt < lastReconciledAt + completionWindow` is merged
     * into the next reconciliation rather than starting a parallel pass.
     */
    private async triggerAcceptance(
        trigger: ReconcilerTrigger,
    ): Promise<
        | { accepted: true; priorChangeRequestActive: boolean }
        | { accepted: false; reason: string; priorReconciledAt: string }
    > {
        const existing = await this.recordRepo.findByRecordKey({
            organizationId: trigger.organizationId,
            repositoryId: trigger.repositoryId,
            prNumber: trigger.prNumber,
            headSha: trigger.headSha,
        });

        if (!existing) {
            return { accepted: true, priorChangeRequestActive: false };
        }

        const triggeredAt = Date.parse(trigger.triggeredAt);
        const lastReconciledAt = existing.lastReconciledAt.getTime();
        const completionWindowMs = 30_000;
        if (
            !Number.isNaN(triggeredAt) &&
            triggeredAt < lastReconciledAt + completionWindowMs
        ) {
            return {
                accepted: false,
                reason: 'Trigger arrived within the in-flight completion window.',
                priorReconciledAt: existing.lastReconciledAt.toISOString(),
            };
        }

        return {
            accepted: true,
            // A prior record at this head SHA could still have an open
            // `REQUEST_CHANGES` on the host; the applier reads it from the
            // record's `inFlightTriggerKind` field — set initially during
            // record creation. For the existing record, a non-null value
            // indicates the prior hold.
            priorChangeRequestActive:
                existing.inFlightTriggerKind === 'change-request-held',
        };
    }

    private buildL0Input(trigger: ReconcilerTrigger): L0AssessInput {
        return {
            prShape: trigger.gates.prShape,
            snapshotKey: trigger.snapshotKey,
        };
    }

    private buildL1Input(trigger: ReconcilerTrigger): L1AssessInput {
        // Graph path is the cached baseline maintained by GraphIndexerService.
        // The changed files travel on the trigger (the stage fills them from
        // the pipeline's full-PR diff); L1 analyzes exactly these.
        return {
            organizationId: trigger.organizationId,
            repositoryId: trigger.repositoryId,
            prNumber: trigger.prNumber,
            headSha: trigger.headSha,
            baseSha: trigger.baseSha,
            changedFiles: trigger.gates.changedFiles,
            // The assessor reads the baseline at this fixed sandbox path
            // (same constant GraphContextService writes to).
            graphPath: '.kodus-graph/base-graph.json',
            snapshotKey: trigger.snapshotKey,
            sandbox: trigger.gates.sandbox,
            platform: trigger.gates.platform,
        };
    }

    private buildL2Input(trigger: ReconcilerTrigger): L2AssessInput {
        return {
            organizationId: trigger.organizationId,
            repositoryId: trigger.repositoryId,
            prNumber: trigger.prNumber,
            title: '',
            headSha: trigger.headSha,
            baseSha: trigger.baseSha,
            changedFiles: trigger.gates.changedFiles,
            configurationKeySnapshot: trigger.snapshotKey,
            snapshotKey: trigger.snapshotKey,
            riskAssessment: trigger.gates.riskAssessment,
        };
    }

    private buildL3Input(trigger: ReconcilerTrigger): L3AssessInput {
        return {
            organizationId: trigger.organizationId,
            repositoryId: trigger.repositoryId,
            prNumber: trigger.prNumber,
            headSha: trigger.headSha,
            baseSha: trigger.baseSha,
            title: '',
            changedFiles: trigger.gates.changedFiles,
            changedLines: 0,
            policies: [],
            snapshotKey: trigger.snapshotKey,
            approvalDecision: trigger.gates.approvalDecision,
        };
    }
}

function toDesiredSummary(
    desired: DesiredHostState,
): ReconcileOutcome['desired'] {
    if (desired.kind === 'APPROVE') {
        return {
            kind: 'APPROVE',
            reason: desired.reason,
            policyId: desired.policyId,
            vetoSources: [],
        };
    }
    if (desired.kind === 'HOLD') {
        return {
            kind: 'HOLD',
            reason: desired.reason,
            vetoSources: desired.vetoSources,
        };
    }
    return {
        kind: 'ORCH_FAIL',
        reason: desired.reason,
        vetoSources: [],
    };
}
