import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

// Product Postgres tables of the Kody Runtime that the API and the product
// worker write (§8): what a resumed setup or a restarted API asks again, the
// gateway's budget and the env tools' audit. The schema is the migration
// MoveRuntimeProductStoresToPostgres2026111200000000; the stores write it
// with SQL (typeorm-runtime-state.stores.ts) for their atomic upserts.

/** A model turn the product ran for a Run (key = the turn's id); a pending turn is never run again. */
@Entity('runtime_model_turn_receipts')
@Index('IDX_runtime_model_turn_receipts_expires', ['expiresAt'])
export class RuntimeModelTurnReceiptModel {
    @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_runtime_model_turn_receipts' }) key: string;
    @Column('text') fingerprint: string;
    @Column('jsonb', { nullable: true }) response: unknown | null;
    @Column('timestamptz', { name: 'expires_at' }) expiresAt: Date;
}

/** One (setupKey, attempt) of Kody's recipe author: who runs it until when, the budget it reserved, its answer. */
@Entity('runtime_recipe_author_receipts')
@Index('IDX_runtime_recipe_author_receipts_expires', ['expiresAt'])
export class RuntimeRecipeAuthorReceiptModel {
    @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_runtime_recipe_author_receipts' }) key: string;
    @Column('text') fingerprint: string;
    @Column('text') owner: string;
    @Column('timestamptz', { name: 'lease_until' }) leaseUntil: Date;
    @Column('timestamptz', { name: 'expires_at' }) expiresAt: Date;
    @Column('jsonb', { nullable: true }) reservation: unknown | null;
    @Column('jsonb', { nullable: true }) outcome: unknown | null;
}

/** A count per key (a setup's calls) that never passes its max. */
@Entity('runtime_setup_call_counts')
@Index('IDX_runtime_setup_call_counts_expires', ['expiresAt'])
export class RuntimeSetupCallCountModel {
    @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_runtime_setup_call_counts' }) key: string;
    @Column('integer') count: number;
    @Column('timestamptz', { name: 'expires_at' }) expiresAt: Date;
}

/** Token counter of one budget scope (run/…, pr/…, org-day/…). */
@Entity('runtime_llm_budget')
@Index('IDX_runtime_llm_budget_expires', { synchronize: false })
export class RuntimeLlmBudgetModel {
    @PrimaryColumn('text', { primaryKeyConstraintName: 'PK_runtime_llm_budget' }) key: string;
    @Column('bigint') tokens: string;
    /** Only the per-day counter expires. */
    @Column('timestamptz', { name: 'expires_at', nullable: true }) expiresAt: Date | null;
    /** Run counter only: settled tokens by model, so the Run's cost is priced per model. */
    @Column('jsonb', { name: 'by_model', default: () => "'{}'" }) byModel: Record<string, unknown>;
}

/** A call in flight: what it reserved and on which counters, until it settles. */
@Entity('runtime_llm_reservations')
@Index('IDX_runtime_llm_reservations_expires', ['expiresAt'])
export class RuntimeLlmReservationModel {
    @PrimaryColumn('uuid', { name: 'reservation_id', primaryKeyConstraintName: 'PK_runtime_llm_reservations' }) reservationId: string;
    @Column('text', { name: 'run_id' }) runId: string;
    @Column('text', { name: 'organization_id' }) organizationId: string;
    @Column('text', { name: 'repository_id' }) repositoryId: string;
    @Column('integer', { name: 'pr_number' }) prNumber: number;
    @Column('text') task: string;
    @Column('timestamptz') at: Date;
    @Column('text', { array: true }) counters: string[];
    @Column('bigint') tokens: string;
    @Column('timestamptz', { name: 'expires_at' }) expiresAt: Date;
}

/** One env_exec or env_fix of a team key (S-27), kept 90 days. */
@Entity('runtime_env_audit')
@Index('IDX_runtime_env_audit_org_kind_at', { synchronize: false })
@Index('IDX_runtime_env_audit_quota', { synchronize: false })
@Index('IDX_runtime_env_audit_at', ['at'])
export class RuntimeEnvAuditModel {
    @PrimaryColumn('text', { name: 'audit_id', primaryKeyConstraintName: 'PK_runtime_env_audit' }) auditId: string;
    @Column('text', { name: 'organization_id' }) organizationId: string;
    @Column('text', { name: 'team_id' }) teamId: string;
    @Column('text', { name: 'key_id' }) keyId: string;
    @Column('text', { name: 'repository_id' }) repositoryId: string;
    @Column('text') kind: string;
    @Column('text') outcome: string;
    @Column('timestamptz') at: Date;
    /** environmentId, sessionId, stepId, the redacted command and the reason. */
    @Column('jsonb', { default: () => "'{}'" }) record: Record<string, unknown>;
}

export const RUNTIME_PRODUCT_STATE_MODELS = [
    RuntimeModelTurnReceiptModel,
    RuntimeRecipeAuthorReceiptModel,
    RuntimeSetupCallCountModel,
    RuntimeLlmBudgetModel,
    RuntimeLlmReservationModel,
    RuntimeEnvAuditModel,
];
