import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import type { EnvironmentRepositoryRole, ForkPullRequestPolicy } from '@libs/runtime/contracts/enums';
import type { MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import type { KeptCheckProbe } from '@libs/runtime/contracts/kept-check';
import type { PreviewSecrets } from '@libs/runtime/contracts/preview';
import type { ProbeAssertions } from '@libs/runtime/contracts/probe-assertions';

import type { PoolPolicy, PoolUsage } from '../domain/pool';
import type { SubmittedRecipe } from '../domain/ports';

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

    /** The org's secrets in this environment's previews (contracts/preview.ts PREVIEW_SECRETS): none, or the same as its Runs. */
    @Column({ name: 'preview_secrets', type: 'varchar', length: 8, default: 'none' })
    previewSecrets: PreviewSecrets;

    /** Run the e2e suite on every push as a CI check (docs/runtime/e2e-suites.md section 11); null: the deployment's default (RUNTIME_SUITE_CI). */
    @Column({ name: 'suite_ci', type: 'boolean', nullable: true })
    suiteCi: boolean | null;

    /** The recipe a developer's agent sent through a team key (env_recipe_submit); null: none. */
    @Column({ name: 'submitted_recipe', type: 'jsonb', nullable: true })
    submittedRecipe: SubmittedRecipe | null;
}

/**
 * A repository of an environment: its `primary` (the environment's own
 * repository, which holds the recipe) or a `member` booted beside it. A
 * repository may be a member of several environments.
 */
@Entity('runtime_environment_repositories')
@Index('UQ_runtime_environment_repositories_env_repo', ['environmentId', 'repositoryId'], { unique: true })
@Index('UQ_runtime_environment_repositories_env_alias', ['environmentId', 'alias'], { unique: true })
@Index('UQ_runtime_environment_repositories_primary', ['environmentId'], { unique: true, where: `"role" = 'primary'` })
@Index('IDX_runtime_environment_repositories_org_repo', ['organizationId', 'repositoryId'])
@Check('CHK_runtime_environment_repositories_role', `"role" IN ('primary', 'member')`)
@Check('CHK_runtime_environment_repositories_alias', `"alias" ~ '^[a-z0-9][a-z0-9._-]{0,62}$'`)
export class RuntimeEnvironmentRepositoryModel {
    @PrimaryGeneratedColumn('uuid')
    uuid: string;

    @Column({ name: 'environment_id', type: 'uuid' })
    environmentId: string;

    @ManyToOne(() => RuntimeEnvironmentModel, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'environment_id', foreignKeyConstraintName: 'FK_runtime_environment_repositories_environment' })
    environment?: RuntimeEnvironmentModel;

    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'repository_id', type: 'varchar', length: 128 })
    repositoryId: string;

    @Column({ name: 'repository_name', type: 'varchar', length: 512 })
    repositoryName: string;

    @Column({ name: 'full_name', type: 'varchar', length: 512 })
    fullName: string;

    @Column({ type: 'varchar', length: 16 })
    role: EnvironmentRepositoryRole;

    /** The repository's directory in the workspace (contracts/workspace.ts REPOSITORY_ALIAS_PATTERN). */
    @Column({ type: 'varchar', length: 63 })
    alias: string;

    /** A pull request of this repository starts a Run of this environment. */
    @Column({ type: 'boolean', default: true })
    triggers: boolean;

    /** A Run boots this repository's open pull request of the same branch name instead of its default branch. */
    @Column({ name: 'pair_branches', type: 'boolean', default: false })
    pairBranches: boolean;

    @CreateDateColumn({ name: 'created_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP(6)' })
    createdAt: Date;

    @UpdateDateColumn({ name: 'updated_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP(6)', onUpdate: 'CURRENT_TIMESTAMP(6)' })
    updatedAt: Date;
}

/** Org-level Runtime settings. */
@Entity('runtime_settings')
@Index('UQ_runtime_settings_org', ['organizationId'], { unique: true })
export class RuntimeSettingsModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'token_budget_per_day', type: 'bigint', nullable: true })
    tokenBudgetPerDay: string | null;

    /** Preview URLs (contracts/preview.ts PreviewSettingsSchema); null: the defaults. */
    @Column({ type: 'jsonb', nullable: true })
    preview: unknown;

    /** 0..100: below this share of measured changed lines a green Run is partly tested; null: the deployment's. */
    @Column({ name: 'exercised_lines_threshold_percent', type: 'smallint', nullable: true })
    exercisedLinesThresholdPercent: number | null;

    /** US$ one hour of the org's own host costs (it prices the machine time of its cells); null: not priced. Numeric reads as a string. */
    @Column({ name: 'machine_usd_per_host_hour', type: 'numeric', precision: 12, scale: 6, nullable: true })
    machineUsdPerHostHour: string | null;

    /** action_required | neutral: what a partly tested Run with something left to decide concludes; null: action_required. */
    @Column({ name: 'partly_tested_check', type: 'varchar', length: 32, nullable: true })
    partlyTestedCheck: string | null;
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

/**
 * The last description a pull request's author wrote, as the Runtime read it on the PR's events
 * (docs/runtime/intent-oracle.md): the Run's intent reads it when the code review replaced the body
 * with Kody's summary. One row per (org, repository, PR).
 */
@Entity('runtime_pr_author_descriptions')
@Index('UQ_runtime_pr_author_descriptions_pr', ['organizationId', 'repositoryId', 'prNumber'], { unique: true })
export class RuntimePrAuthorDescriptionModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'repository_id', type: 'varchar', length: 128 })
    repositoryId: string;

    @Column({ name: 'pr_number', type: 'integer' })
    prNumber: number;

    @Column({ type: 'text' })
    description: string;
}

/**
 * A kept check (docs/runtime/kept-checks.md): the probe of a regression a user
 * kept, so every later Run of the repository in that environment plays it.
 * `uuid` is the keptCheckId. One active check per (org, environment,
 * repository, probe key); a removed one keeps its row (who, when) for the metric.
 */
@Entity('runtime_kept_checks')
@Index('IDX_runtime_kept_checks_scope', ['organizationId', 'environmentId', 'repositoryId'])
export class RuntimeKeptCheckModel extends CoreModel {
    @Column({ name: 'organization_id', type: 'varchar', length: 128 })
    organizationId: string;

    @Column({ name: 'environment_id', type: 'varchar', length: 128 })
    environmentId: string;

    @Column({ name: 'repository_id', type: 'varchar', length: 128 })
    repositoryId: string;

    @Column({ name: 'probe_key', type: 'varchar', length: 1024 })
    probeKey: string;

    @Column({ name: 'entry_point', type: 'varchar', length: 512 })
    entryPoint: string;

    /** The probe as recorded on the Run (redacted spec, purpose, expected, compare), main's expectation and the fields that diverged. */
    @Column({ name: 'check', type: 'jsonb' })
    check: { probe: KeptCheckProbe; assertions?: ProbeAssertions; differingFields: string[] };

    @Column({ name: 'source_run_id', type: 'varchar', length: 128 })
    sourceRunId: string;

    @Column({ name: 'source_probe_id', type: 'varchar', length: 128 })
    sourceProbeId: string;

    @Column({ name: 'source_pr_number', type: 'integer' })
    sourcePrNumber: number;

    @Column({ name: 'kept_by', type: 'varchar', length: 128 })
    keptBy: string;

    @Column({ name: 'removed_at', type: 'timestamp', nullable: true })
    removedAt: Date | null;

    @Column({ name: 'removed_by', type: 'varchar', length: 128, nullable: true })
    removedBy: string | null;
}
