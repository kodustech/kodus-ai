import type {
    GateVerdict,
    L1Verdict,
} from '@libs/code-review/domain/risk/pr-decision-graph-verdict';
import type {
    L0Verdict,
    L2Verdict,
    L3Verdict,
} from '@libs/code-review/domain/risk/pr-decision-reducer';
import type { ApprovalDecision } from '@libs/code-review/domain/approval/approval-decision';
import type { RiskAssessmentResult } from '@libs/code-review/domain/risk/risk-assessment';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

/**
 * Per-PR reconciler ports. Pure ports — concrete adapters wire these to
 * existing implementations:
 *   L0: deterministic conditions function (lives in this AGPL module)
 *   L1: KodusGraphCli.analyzeFiles + MapAnalyzeJsonToL1GateVerdict
 *   L2: assessChangeRisk via the existing pr-risk-assessment flow
 *   L3: ApprovalPoliciesService.matchPolicy
 *   HostDriver: codeManagementService + ownChangeRequest + postConditionalApprovalReason
 *   Recorder: existing recordApprovalReasonDelivery outbox
 *
 * Concrete adapters are written as separate files; the reconciler itself
 * ships without EE imports.
 */
export interface L0Assessor {
    /** Deterministic. Always returns Ready. */
    assess(input: L0AssessInput): Promise<GateVerdict<L0Verdict>>;
}

export interface L0AssessInput {
    /** The PR shape the conditions read. */
    prShape: {
        isDraft?: boolean;
        isBotAuthor?: boolean;
    };
    snapshotKey: string;
}

export interface L1Assessor {
    /** Reads the cached baseline graph + parse the PR's changed files. */
    assess(input: L1AssessInput): Promise<GateVerdict<L1Verdict>>;
}

export interface L1AssessInput {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    changedFiles: ReadonlyArray<{ filename: string; status: string }>;
    graphPath: string;
    snapshotKey: string;
    /** The sandbox the pipeline created for this review. Null when none. */
    sandbox: SandboxInstance | null;
    /**
     * The provider platform ('github', 'forgejo', …). The graph baseline is
     * keyed on the platform and the repository's external id, so the L1
     * adapter needs it to find the repository record.
     */
    platform: string;
}

export interface L2Assessor {
    /** Wraps the existing Change-Risk service. May return Unavailable on rate-limit. */
    assess(input: L2AssessInput): Promise<GateVerdict<L2Verdict>>;
}

export interface L2AssessInput {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    title: string;
    body?: string;
    headSha: string;
    baseSha: string;
    changedFiles: ReadonlyArray<{ filename: string; status: string }>;
    criteria?: ReadonlyArray<{
        id: string;
        name: string;
        enabled: boolean;
        instructions: string;
        includedFiles?: ReadonlyArray<string>;
        excludedFiles?: ReadonlyArray<string>;
    }>;
    configurationKeySnapshot: string;
    snapshotKey: string;
    /**
     * The risk verdict the pipeline's risk stage already produced for this
     * PR. Null when the risk engine produced none — the assessor then fails
     * closed, because an absent verdict is not a clean one.
     */
    riskAssessment: RiskAssessmentResult | null;
}

export interface L3Assessor {
    /** Maps the configured approvalPolicies + PR state onto a verdict. */
    assess(input: L3AssessInput): Promise<GateVerdict<L3Verdict>>;
}

export interface L3AssessInput {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    title: string;
    author?: string;
    labels?: ReadonlyArray<string>;
    changedFiles: ReadonlyArray<{ filename: string; status: string }>;
    changedLines: number;
    policies: ReadonlyArray<{
        id: string;
        name: string;
        enabled: boolean;
        authors?: ReadonlyArray<string>;
        authorTeams?: ReadonlyArray<string>;
        labels?: ReadonlyArray<string>;
        includedFiles?: ReadonlyArray<string>;
        excludedFiles?: ReadonlyArray<string>;
        maxChangedLines?: number;
        lineCountExcludedFiles?: ReadonlyArray<string>;
        instruction?: string;
    }>;
    snapshotKey: string;
    /**
     * The approval decision the pipeline's policy stage already produced for
     * this PR. Null when the matcher produced none — the assessor then fails
     * closed.
     */
    approvalDecision: ApprovalDecision | null;
}

/**
 * DI tokens for the reconciler's ports. The reconciler depends on the
 * interfaces, never on the adapters; the module binds each token to its
 * concrete adapter.
 */
export const L0_ASSESSOR_TOKEN = Symbol.for('PrDecisionL0Assessor');
export const L1_ASSESSOR_TOKEN = Symbol.for('PrDecisionL1Assessor');
export const L2_ASSESSOR_TOKEN = Symbol.for('PrDecisionL2Assessor');
export const L3_ASSESSOR_TOKEN = Symbol.for('PrDecisionL3Assessor');
export const HOST_DRIVER_TOKEN = Symbol.for('PrDecisionHostDriver');
export const DECISION_RECORDER_TOKEN = Symbol.for('PrDecisionRecorder');

export interface ReconcilerTrigger {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    /** What fired this reconcile (commit / comment / config / in-flight cleared / poll). */
    kind:
        | 'commit-pushed'
        | 'comment-resolved'
        | 'config-edited'
        | 'in-flight-cleared'
        | 'safety-poll';
    triggeredAt: string;
    snapshotKey: string;
    /**
     * The gate inputs the pipeline already produced, carried on the trigger
     * so every assessor is a pure function of its input.
     *
     * The trigger is per-PR and the reconciler may run for several PRs
     * concurrently in one worker process (the code-review channel's
     * `prefetchCount` is 20), so this data must travel WITH the reconcile
     * rather than live in a module-level holder: a holder would let one
     * PR's reconcile read another PR's verdict.
     */
    gates: ReconcilerGateInputs;
}

/**
 * The gate inputs the pipeline produced for this PR.
 *
 * Each field is what the corresponding stage had already computed:
 *   - `riskAssessment`  ← `AssessPrRiskStage` (L2)
 *   - `approvalDecision`← `DecidePrApprovalStage` (L3)
 *   - `sandbox`          ← `CreateSandboxStage` (L1 needs it)
 *   - `prShape`          ← the PR's own shape (L0)
 */
export interface ReconcilerGateInputs {
    /** The L2 risk verdict, or null when the risk engine produced none. */
    riskAssessment: RiskAssessmentResult | null;
    /** The L3 approval decision, or null when the policy matcher produced none. */
    approvalDecision: ApprovalDecision | null;
    /** The provider platform ('github', 'forgejo', …). L1 keys the graph
     * baseline on it. */
    platform: string;
    /** The PR shape L0 reads. */
    prShape: {
        isDraft?: boolean;
        isBotAuthor?: boolean;
    };
    /**
     * The PR's changed files, carried so L1 can run `kodus-graph analyze`
     * over them. The stage fills this from the pipeline's full-PR diff
     * (`fullPrFiles`). Without it L1 sees an empty file list and reports
     * `Unavailable` ("no changed source files") on every PR — the graph gate
     * would be dead in the live path.
     */
    changedFiles: ReadonlyArray<{ filename: string; status: string }>;
    /**
     * The sandbox the pipeline created for this review. L1 runs
     * `kodus-graph analyze` inside it. Null when no sandbox was created.
     */
    sandbox: SandboxInstance | null;
    /**
     * The host context the projection writes through. The applier's
     * `HostRecord` carries only ids, so the organisation and the repository
     * the provider calls need travel here.
     */
    host: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    };
}

/**
 * The recorder persists one row per apply transition in the existing
 * `pull_request_messages` outbox. The runtime adapter (not yet in this PR)
 * wraps the existing `recordApprovalReasonDelivery` / `postConditionalApprovalReason`
 * path; the reconciler depends on the port, not on the cron or any EE module.
 */
export interface IDecisionRecorder {
    record(input: DecisionRecorderInput): Promise<void>;
}

export interface DecisionRecorderInput {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
    baseSha: string;
    decision: 'approve' | 'hold';
    reason: string;
    occurredAt: string;
    /** `notAfter` declines for late hold posts, per the existing cron's
     * `reasonWriteDeadline` semantics. Approves ignore `notAfter` (always recorded). */
    notAfter?: string;
}

export interface ReconcileOutcome {
    record: {
        organizationId: string;
        repositoryId: string;
        prNumber: number;
        headSha: string;
        baseSha: string;
        configurationKey: string;
    };
    desired: {
        kind: 'APPROVE' | 'HOLD' | 'ORCH_FAIL';
        reason: string;
        policyId?: string;
        vetoSources: ReadonlyArray<string>;
    };
    apply:
        | { status: 'applied' }
        | {
              status: 'partial';
              attemptedSteps: ReadonlyArray<string>;
              reason: string;
          }
        | { status: 'skipped-nochange' }
        | {
              status: 'aborted';
              reason: 'prior-reconciliation-running';
              priorReconciledAt: string;
          };
    recordedAt: string;
}
