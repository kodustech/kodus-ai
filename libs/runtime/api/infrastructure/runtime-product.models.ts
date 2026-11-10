import { Column, Entity, Index } from 'typeorm';

import type { ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import type { MachineSizePreset } from '@libs/runtime/contracts/machine-size';

import type { PoolPolicy, PoolUsage } from '../domain/pool';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

// Product Postgres tables of the Kody Runtime (§8), written only by the API.

/** One environment per connected repo; `uuid` is the environmentId. */
@Entity('runtime_environments')
@Index('UQ_runtime_environments_org_repo', ['organizationId', 'repositoryId'], { unique: true })
export class RuntimeEnvironmentModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'team_id', type: 'varchar', length: 128 })
    teamId: string;

    @Column({ name: 'repository_id', type: 'varchar', length: 128 })
    repositoryId: string;

    @Column({ name: 'repository_name', type: 'varchar', length: 512 })
    repositoryName: string;

    @Column({ type: 'varchar', length: 32, default: 'active' })
    state: 'setup_requested' | 'active';

    @Column({ name: 'setup_requested_at', type: 'timestamp', nullable: true })
    setupRequestedAt: Date | null;

    /** Keep a failed default-branch setup's machines until the hard TTL for diagnosis (opt-in by the org admin). */
    @Column({ name: 'diagnostic_hold', type: 'boolean', default: false })
    diagnosticHold: boolean;

    /** The org admin's warm pool size; null: the plan's default. */
    @Column({ name: 'pool_size', type: 'integer', nullable: true })
    poolSize: number | null;

    /** The org admin's machine size preset (contracts/machine-size.ts); null: the cell's default. */
    @Column({ name: 'machine_size', type: 'varchar', length: 16, nullable: true })
    machineSize: MachineSizePreset | null;

    /** What a PR from a fork does (contracts/enums.ts FORK_PULL_REQUEST_POLICIES). */
    @Column({ name: 'fork_pull_requests', type: 'varchar', length: 32, default: 'require_approval' })
    forkPullRequests: ForkPullRequestPolicy;

    /** When the machines are kept ready (domain/pool.ts PoolPolicy); null: always. */
    @Column({ name: 'pool_policy', type: 'jsonb', nullable: true })
    poolPolicy: PoolPolicy | null;

    /** The last pull request event of the environment's repository. */
    @Column({ name: 'pool_activity_at', type: 'timestamptz', nullable: true })
    poolActivityAt: Date | null;

    /** The size the cell was last asked for. */
    @Column({ name: 'pool_applied_size', type: 'integer', nullable: true })
    poolAppliedSize: number | null;

    /** This month's estimated machine-minutes kept ready. */
    @Column({ name: 'pool_usage', type: 'jsonb', nullable: true })
    poolUsage: PoolUsage | null;
}

/** Org-level Runtime settings. */
@Entity('runtime_settings')
@Index('UQ_runtime_settings_org', ['organizationId'], { unique: true })
export class RuntimeSettingsModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'token_budget_per_day', type: 'bigint', nullable: true })
    tokenBudgetPerDay: string | null;
}

/** Per-repo Runtime settings: pilot and who may ask `@kody runtime`. */
@Entity('runtime_repository_settings')
@Index('UQ_runtime_repository_settings_org_repo', ['organizationId', 'repositoryId'], { unique: true })
export class RuntimeRepositorySettingsModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'repository_id', type: 'varchar', length: 128 })
    repositoryId: string;

    @Column({ type: 'boolean', default: false })
    pilot: boolean;

    @Column({ name: 'who_can_ask', type: 'varchar', length: 32, default: 'writers' })
    whoCanAsk: string;

    /** off | on_request | rules; null on rows written before the mode existed. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    mode: string | null;

    @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
    rules: unknown[];

    @Column({ name: 'run_on_agent_prs', type: 'boolean', default: false })
    runOnAgentPullRequests: boolean;

    @Column({ name: 'run_on_new_pushes', type: 'boolean', default: false })
    runOnNewPushes: boolean;
}

/** 👍/👎 on a tested path of a Run, one per user (screen 8). */
@Entity('runtime_finding_feedback')
@Index('UQ_runtime_finding_feedback_run_probe_user', ['runId', 'probeId', 'userId'], { unique: true })
export class RuntimeFindingFeedbackModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'run_id', type: 'varchar', length: 128 })
    runId: string;

    @Column({ name: 'probe_id', type: 'varchar', length: 128 })
    probeId: string;

    @Column({ name: 'user_id', type: 'varchar', length: 128 })
    userId: string;

    @Column({ type: 'varchar', length: 8 })
    value: 'up' | 'down';
}

/** "This change is intended" on a finding of a Run, one per finding; a learning signal, never the Run's verdict. */
@Entity('runtime_finding_intent')
@Index('UQ_runtime_finding_intent_run_probe', ['runId', 'probeId'], { unique: true })
export class RuntimeFindingIntentModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'run_id', type: 'varchar', length: 128 })
    runId: string;

    @Column({ name: 'probe_id', type: 'varchar', length: 128 })
    probeId: string;

    @Column({ name: 'user_id', type: 'varchar', length: 128 })
    userId: string;
}
