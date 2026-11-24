import { Column, Entity, Index, Unique } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

/**
 * One row per (organizationId, repoId, prNumber, headSha). Holds the source
 * of truth for the per-PR reconciler: gate verdicts, snapshot keys, host
 * write attempts, retry state. Idempotent on (repoId, prNumber, headSha).
 *
 * Columns are intentionally wide (JSONB) so the reconciler can grow its
 * reducer shape and refusal-map backoff without further migrations. JSONB
 * lets the reducer write a single column without table-shape churn. See
 * `pr-decision-orchestrator` design §Decision 2 for the rationale.
 */
@Entity('pr_decision_records')
@Unique('UQ_pr_decision_records_repo_pr_head', [
    'repositoryId',
    'prNumber',
    'headSha',
])
@Index('IX_pr_decision_records_org_repo', ['organizationId', 'repositoryId'])
@Index('IX_pr_decision_records_snapshot', ['lastReconciledAt'])
export class PrDecisionRecordModel extends CoreModel {
    @Column({ type: 'uuid', name: 'organization_id' })
    organizationId: string;

    /**
     * The PROVIDER's repository id — Gitea's numeric id, GitHub's node id —
     * not a Kodus uuid. The other Postgres tables that key a repository store
     * it as varchar (`automation_execution.repositoryId`), and the pipeline's
     * `Repository.id` is the provider's id, so a uuid column here rejected
     * the value at runtime.
     */
    @Column({ type: 'varchar', name: 'repository_id' })
    repositoryId: string;

    @Column({ type: 'integer', name: 'pr_number' })
    prNumber: number;

    @Column({ type: 'text', name: 'head_sha' })
    headSha: string;

    @Column({ type: 'text', name: 'base_sha' })
    baseSha: string;

    /**
     * SHA-256 hex of the configuration key (criteria + model + language + slot).
     * Risk verdicts produced under a different configurationKey are `Stale`
     * per `pr-decision-graph-verdict.ts`. See `risk-configuration.ts:24`.
     */
    @Column({ type: 'text', name: 'configuration_key' })
    configurationKey: string;

    /**
     * Snapshot of the four gate verdicts + the AC verdict at the moment of
     * the latest applied reconcile. JSONB; reducer reads on hit.
     */
    @Column({ type: 'jsonb', name: 'gate_verdicts_snapshot' })
    gateVerdictsSnapshot: PrDecisionGateVerdictsJson;

    /**
     * `Applier`'s outcome record. JSONB; recorded by the applier after every
     * attempt. `appliedOrSkippedSince` is the last time a successful applier
     * pass recorded a `skipped-nochange` or `applied` outcome.
     */
    @Column({ type: 'jsonb', name: 'last_apply_outcome' })
    lastApplyOutcome: PrDecisionApplyOutcomeJson;

    @Column({ type: 'timestamp', name: 'last_reconciled_at' })
    lastReconciledAt: Date;

    @Column({
        type: 'integer',
        name: 'consecutive_failures',
        default: 0,
    })
    consecutiveFailures: number;

    /**
     * Optional; captured when the reconciler is paused mid-flight. The
     * orchestrator reloads this on resume and continues from `lastStep`.
     */
    @Column({
        type: 'text',
        name: 'in_flight_trigger_kind',
        nullable: true,
    })
    inFlightTriggerKind: string | null;
}

/** JSONB shape for `gateVerdictsSnapshot`. Decoupled from `GateVerdict<T>`
 * because the JSONB layer is the *value* the reducer reads on hit; `GateVerdict`
 * is the *constructor type* we use in-process. Keep them in lockstep.
 */
export interface PrDecisionGateVerdictsJson {
    snapshotKey: string;
    capturedAt: string; // ISO
    l0?: unknown;
    l1?: unknown;
    l2?: unknown;
    l3?: unknown;
    ac?: unknown;
}

export interface PrDecisionApplyOutcomeJson {
    kind: 'applied' | 'partial' | 'skipped-nochange';
    steps: ReadonlyArray<{
        step: 'dismiss' | 'approve' | 'upsertComment';
        result: { status: 'ok' | 'retry' | 'fatal'; reason?: string };
    }>;
    decidedAt: string; // ISO
}
