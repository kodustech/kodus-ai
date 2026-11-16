import type { PreviewSecrets } from '@libs/runtime/contracts/preview';
import type { EnvironmentSetupRecord, RunProjectionReader, RunProjectionStore, RunStreamStore, RuntimeRunProjection, RuntimeRunRequested } from '@libs/runtime/run';
import type { AgentRunner } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { Lesson } from '@libs/runtime/blockers/lessons';
import type { EnvironmentRepositoryRole, ForkPullRequestPolicy, RecipeChangedPath } from '@libs/runtime/contracts/enums';
import type { MachineSizePreset } from '@libs/runtime/contracts/machine-size';
import { MAX_WORKSPACE_REPOSITORIES } from '@libs/runtime/contracts/workspace';
import type { S3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import type { RuntimeLlmBudgetLimits } from './budget';
import type { CellTopology } from '@libs/runtime/contracts/cell-token';
import type { RuntimeMachineSizePlan } from './machine-size-plan';
import type { CellHostPrice, RunClaimUsage } from './run-cost';
import type { RuntimeLlmSpendRow } from './llm-spend';
import type { MachineUnitPrices, UsageClaimRecord, UsageReportFilters, UsageRunRecord, UsageSandboxOperations } from './usage-report';
import type { RuntimeMachineUsageToday } from './machine-minutes-today';
import type { PoolPolicy, PoolUsage, RuntimePoolPlan } from './pool';
import type { RuntimeMode, TriggerRule } from './trigger-rules';

// Ports of the API side of the Runtime. The API reads the Runtime stores
// (projection, stream, Runtime Postgres) and never writes them; every write
// that changes Runtime state goes through the product outbox.

export const RUNTIME_RUN_PROJECTION_STORE = Symbol.for('RuntimeApi.RunProjectionStore');
export const RUNTIME_RUN_STREAM_STORE = Symbol.for('RuntimeApi.RunStreamStore');
export const RUNTIME_CELL_READER = Symbol.for('RuntimeApi.CellReader');
export const RUNTIME_CELL_TOKEN_READER = Symbol.for('RuntimeApi.CellTokenReader');
export const RUNTIME_ENVIRONMENT_READER = Symbol.for('RuntimeApi.EnvironmentReader');
export const RUNTIME_GIT_PORT = Symbol.for('RuntimeApi.GitPort');
export const RUNTIME_REPO_TOKEN_ISSUER = Symbol.for('RuntimeApi.RepoTokenIssuer');
export const RUNTIME_LLM_PROVIDER = Symbol.for('RuntimeApi.LlmProvider');
export const RUNTIME_LLM_USAGE_STORE = Symbol.for('RuntimeApi.LlmUsageStore');
export const RUNTIME_TEAM_REPOSITORIES = Symbol.for('RuntimeApi.TeamRepositories');
export const RUNTIME_SETTINGS_STORE = Symbol.for('RuntimeApi.SettingsStore');
export const RUNTIME_PRODUCT_ENVIRONMENT_STORE = Symbol.for('RuntimeApi.ProductEnvironments');
export const RUNTIME_ENVIRONMENT_REPOSITORY_STORE = Symbol.for('RuntimeApi.EnvironmentRepositories');
export const RUNTIME_ORG_REPOSITORIES = Symbol.for('RuntimeApi.OrgRepositories');
export const RUNTIME_EGRESS_READER = Symbol.for('RuntimeApi.EgressReader');
export const RUNTIME_CLAIM_USAGE_READER = Symbol.for('RuntimeApi.ClaimUsageReader');
export const RUNTIME_MACHINE_USAGE_READER = Symbol.for('RuntimeApi.MachineUsageReader');
export const RUNTIME_USAGE_REPORT_READER = Symbol.for('RuntimeApi.UsageReportReader');
export const RUNTIME_API_CONFIG = Symbol.for('RuntimeApi.Config');
export const RUNTIME_CLOCK = Symbol.for('RuntimeApi.Clock');

/**
 * What RUNTIME_RUN_PROJECTION_STORE gives the API: a reader. The API never
 * writes the projection (ADR-025), and the type says so.
 */
export type { RunProjectionReader, RunStreamStore, RuntimeRunProjection };
/** @deprecated the API holds a RunProjectionReader; the writer belongs to the runtime-worker. */
export type { RunProjectionStore };

export interface RuntimeApiConfig {
    /**
     * Ed25519 private key the API signs preview grants with
     * (RUNTIME_PREVIEW_GRANT_PRIVATE_KEY: PKCS8 PEM, or base64 of PKCS8 DER);
     * the preview edge verifies them with the public key. Absent: no grant.
     */
    previewGrantPrivateKey?: string;
    /** Dev only (RUNTIME_PREVIEW_PUBLIC_PORT): the local preview edge's port in the grant URL. */
    previewPublicPort?: number;
    /**
     * RUNTIME_PREVIEW_DOMAIN, as the worker reads it: previews are offered
     * (the Run page, the PR comment, the settings) only where it is set and
     * a grant key is, the "off until set" rule of decision 1.
     */
    previewDomain?: string;
    /** Trusted deployment origin advertised by the public A2A card; never request Host. */
    a2aBaseUrl?: string;
    /** HMAC secret of the Run token (RUNTIME_RUN_TOKEN_SECRET). */
    runTokenSecret?: string;
    /** HMAC secret shared with the evidence server (RUNTIME_EVIDENCE_SIGNING_SECRET). */
    evidenceSigningSecret?: string;
    /** Isolated origin of the evidence server (RUNTIME_EVIDENCE_BASE_URL). */
    evidenceBaseUrl?: string;
    evidenceTtlSeconds: number;
    /** RUNTIME_EVIDENCE_STORE: file (the worker's evidence server, HMAC URLs) or s3 (presigned GETs of the bucket). */
    evidenceStore?: 'file' | 's3';
    /** RUNTIME_EVIDENCE_S3_*, when the store is s3: a key that may only GetObject is enough. */
    evidenceS3?: S3EvidenceConfig;
    llmBudget: RuntimeLlmBudgetLimits;
    /** The plan's warm pool: default and ceiling per environment (RUNTIME_POOL_*). */
    pool: RuntimePoolPlan;
    /** The plan's machine size ceiling per environment (RUNTIME_MACHINE_SIZE_MAX). */
    machineSize: RuntimeMachineSizePlan;
    /** Kodus on-call users: global stop and managed cells (RUNTIME_ONCALL_USER_IDS). */
    oncallUserIds: string[];
    /** Extra denylist entries on top of the Kodus default (RUNTIME_EGRESS_DENYLIST). */
    egressDenylist: string[];
    /** Long-poll wait of the stream route. */
    streamLongPollMs: number;
    streamPollIntervalMs: number;
    /**
     * Key that seals the repo and Run tokens the product hands the Runtime
     * (RUNTIME_SECRET_SEAL_KEY, 32 bytes as hex or base64; sealed-secret.ts).
     * Without it nothing that carries a token is enqueued.
     */
    secretSealKey?: string;
    /** RUNTIME_STREAM_STORE: postgres (default, read with runtimeDatabaseReadUrl) or file (RUNTIME_STREAM_DIR). */
    streamStore?: 'file' | 'postgres';
    /** Where the file Run streams live (RUNTIME_STREAM_DIR). */
    streamDir?: string;
    /** Read-only URL of the Runtime Postgres (RUNTIME_DATABASE_READ_URL). */
    runtimeDatabaseReadUrl?: string;
    /**
     * The host of each Kodus-managed shared cell, by cellId (RUNTIME_CELL_PRICES):
     * what prices a Run's held memory on it (run-cost.ts). A cell absent here is not priced.
     */
    cellPrices?: Record<string, CellHostPrice>;
    /**
     * What one GB·min and one vCPU·min of machine time cost
     * (RUNTIME_MACHINE_USD_PER_GB_MINUTE, RUNTIME_MACHINE_USD_PER_VCPU_MINUTE);
     * 0, the default, is "no price set" and the usage report prices nothing with it.
     */
    machineUnitPrices?: MachineUnitPrices;
    /** The org's machine minutes per UTC day the hub admits (RUNTIME_MACHINE_MINUTES_PER_ORG_DAY, shared with apps/runtime); 0 = unlimited. */
    machineMinutesPerOrgDay?: number;
}

export type Clock = () => Date;

export interface RuntimeCell {
    cellId: string;
    /** Display name; the managed fleet shows as "Kodus cloud". */
    name?: string;
    organizationId: string | null;
    /** `kodus` = managed cell (on-call only); `customer` = registered by the org. */
    owner: 'kodus' | 'customer';
    topology: CellTopology | 'managed';
    status: 'connected' | 'disconnected' | 'revoked';
    certificateSerial?: string;
    certificateExpiresAt?: string;
    lastHeartbeatAt?: string;
    registeredAt?: string;
}

export interface RuntimeCellReader {
    /** Cells of the org (customer cells only; managed cells are on-call business). */
    listByOrganization(organizationId: string): Promise<RuntimeCell[]>;
    /** The managed cells (owner `kodus`, not revoked): shared by every org, shown only as one aggregate. */
    listManaged(): Promise<RuntimeCell[]>;
    get(cellId: string): Promise<RuntimeCell | null>;
}

/** A registration token as the Runtime stores it: its hash (the id), never the token. */
export interface RuntimeCellTokenRow {
    tokenHash: string;
    organizationId: string;
    topology: CellTopology;
    issuedBy: string;
    issuedAt: string;
    expiresAt: string;
    usedAt?: string;
    revokedAt?: string;
}

/** runtime_cell_tokens, read-only (the Runtime writes it; the API revokes through the outbox). */
export interface RuntimeCellTokenReader {
    /** The org's tokens issued since `since`, newest first. */
    listByOrganization(organizationId: string, since: Date): Promise<RuntimeCellTokenRow[]>;
    get(tokenHash: string): Promise<RuntimeCellTokenRow | null>;
}

export interface RuntimeEnvironmentRef {
    environmentId: string;
    organizationId: string;
    teamId: string;
    repositoryId: string;
    /** Current image and exposed services, when the reader knows them. */
    imageId?: string;
    expose?: RuntimeRunRequested['environment']['expose'];
}

export interface RuntimeEnvironmentReader {
    /** The environment of that org, or null (another org's environment reads as absent). */
    get(organizationId: string, environmentId: string): Promise<RuntimeEnvironmentRef | null>;
}

export interface OrgTeam {
    organizationId: string;
    teamId: string;
}

/** What the Git API says about a PR right now (ADR-057): every trigger decision reads this, never the webhook. */
export interface PullRequestHead {
    headSha: string;
    baseSha: string;
    /** The native PR target ref, when the Git API answers it; never the repo default. */
    baseBranch?: string;
    /** The branch the PR comes from, when the Git API answers it: what a paired repository's PR is found by. */
    headBranch?: string;
    fork: boolean;
    authorId?: string;
    authorLogin?: string;
    /** The author is a bot account (a GitHub App, `[bot]`), when the platform says so. */
    authorIsBot?: boolean;
    state?: 'open' | 'closed' | 'merged';
    /** Undefined when the platform did not answer it. */
    draft?: boolean;
    /** Live labels; undefined when the platform has none or did not answer. */
    labels?: string[];
}

/**
 * An open pull request as a platform's listing gives it. `updatedAt` is the
 * PR's last change of any kind (a push, a comment, a label): never earlier
 * than the push of its head, so a PR not updated since a time had its head
 * pushed before it.
 */
export interface OpenPullRequestSummary {
    number: number;
    headSha: string;
    draft?: boolean;
    /** ISO time; absent when the listing does not say. */
    updatedAt?: string;
}

/** The PR's diff as the Git API gave it, and whether the product had to cut it. */
export interface PullRequestDiff {
    files: RuntimeRunRequested['diff'];
    /** Files or bytes past the caps were left out (the Run is partly tested at best). */
    truncated: boolean;
    /** Root `.kodus/` files the PR changes, from the whole file list before any cut: the worker picks the recipe among them (S-19). */
    recipeFiles?: RecipeChangedPath[];
}

export interface GitIdentity {
    id?: string;
    login?: string;
}

/** Everything the Runtime needs from the Git API, read by the product (ADR-057: never the webhook payload). */
export interface RuntimeGitPort {
    getPullRequestHead(input: OrgTeam & { repositoryId: string; repositoryName: string; prNumber: number }): Promise<PullRequestHead | null>;
    getPullRequestDiff(
        input: OrgTeam & { repositoryId: string; repositoryName: string; prNumber: number; headSha: string },
    ): Promise<PullRequestDiff>;
    /** The Git identity of a Kodus user, or null when it cannot be told. */
    resolveGitIdentity(input: OrgTeam & { userId: string; email?: string }): Promise<GitIdentity | null>;
    /** true/false from the Git API; undefined when the platform cannot say (which denies). */
    userCanWrite(input: OrgTeam & { repositoryId: string; repositoryName: string; identity: GitIdentity }): Promise<boolean | undefined>;
    /** Whether the Git identity belongs to the org of the integration; undefined when the platform cannot say (which denies). */
    isOrganizationMember(input: OrgTeam & { identity: GitIdentity }): Promise<boolean | undefined>;
    /**
     * The newest open, non-fork pull request of the repository whose source
     * branch is `branch`, with its shas, or null when there is none: the PR a
     * paired repository of a multi-repository Run boots (pair_branches).
     */
    findOpenPullRequestByBranch?(
        input: OrgTeam & { repositoryId: string; repositoryName: string; branch: string },
    ): Promise<{ number: number; headSha: string; baseSha: string } | null>;
    /**
     * Every open pull request of the repository with its head, from one
     * listing call (the lost-webhook reconciler). `unsupported_platform` when
     * this platform's listing does not give a full head SHA. A PR the listing
     * gives no full SHA for is left out, never guessed.
     */
    listOpenPullRequests?(
        input: OrgTeam & { repositoryId: string; repositoryName: string },
    ): Promise<OpenPullRequestSummary[] | 'unsupported_platform'>;
    /** The default branch and its head SHA, the commit an environment setup boots (§6). */
    getDefaultBranchHead(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<DefaultBranchHead>;
    /**
     * One file at an exact commit: its text, null when it is not there, or
     * `unsupported_platform` when this platform cannot read it here. Throws on
     * a Git API failure or a file larger than maxBytes.
     */
    readFileAtCommit(
        input: OrgTeam & { repositoryId: string; repositoryName: string; path: string; sha: string; maxBytes: number },
    ): Promise<string | null | 'unsupported_platform'>;
    /**
     * Every file path of the repository at an exact commit, from the
     * integration's tree API (Kody's recipe author lists directories from it).
     * `unsupported_platform` when this platform cannot list a commit here.
     * Throws on a Git API failure, never answers a failed listing as empty.
     */
    listFilesAtCommit?(
        input: OrgTeam & { repositoryId: string; repositoryName: string; sha: string },
    ): Promise<string[] | 'unsupported_platform'>;
    /**
     * Opens a PR from a new branch off `baseBranch` with these files (a recipe
     * fix, ADR-015: the recipe only changes by a PR). Null when the platform
     * refused it.
     */
    openPullRequestWithFiles?(
        input: OrgTeam & {
            repositoryId: string;
            repositoryName: string;
            baseBranch: string;
            branch: string;
            title: string;
            body: string;
            commitMessage: string;
            files: { path: string; content: string }[];
        },
    ): Promise<{ number: number; url: string } | null>;
}

export type DefaultBranchHead =
    | { status: 'ok'; branch: string; sha: string }
    /** The repository or its default branch is not there (an empty repo). */
    | { status: 'not_found' }
    /** The platform integration has no way to read it yet (GitHub only today). */
    | { status: 'unsupported_platform'; platform: string | null };

/** Download token for one repo, contents:read, 1 h (ADR-002, ADR-052); never the cached installation token. */
export interface RuntimeRepoTokenIssuer {
    issue(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<string>;
}

export interface RuntimeLlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface RuntimeLlmCompletion {
    text: string;
    /**
     * What the provider reported; absent when it reported nothing (the gateway then keeps the reservation).
     * Cache tokens are part of inputTokens (ai@7 normalizes them so).
     */
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    /** The model that answered, so the Run's cost is priced by it. */
    model?: string;
}

/** The provider call of the gateway (LLM.run with the org slot); tests use a fake. */
export interface RuntimeLlmProvider {
    complete(input: {
        organizationId: string;
        teamId: string;
        runId: string;
        repositoryId: string;
        prNumber: number;
        task: string;
        messages: RuntimeLlmMessage[];
        maxOutputTokens?: number;
    }): Promise<RuntimeLlmCompletion>;
}

export interface RuntimeLlmUsageRecord {
    runId: string;
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    task: string;
    inputTokens: number;
    outputTokens: number;
    at: Date;
}

/** What the store sums when it reserves: the three budget scopes of the call. */
export interface RuntimeLlmSpendSnapshot {
    run: number;
    pullRequest: number;
    orgToday: number;
}

/**
 * The gateway's budget (S-47), in the product Postgres. Each call's consumption is
 * also its usage span in `observability_telemetry`; this store holds only the
 * counters the budget decides on and the reservations in flight.
 */
export interface RuntimeLlmUsageStore {
    /**
     * Check and reserve in one step (S-47): under a lock per org, sums the spend
     * (reservations in flight included), asks `decide` how much this call may
     * reserve, and inserts that reservation. Concurrent calls of one org see
     * each other's reservations, so they cannot all pass on the same total.
     * `decide` returns the tokens to reserve, or null to refuse.
     */
    reserve(input: {
        usage: Omit<RuntimeLlmUsageRecord, 'inputTokens' | 'outputTokens'>;
        orgDayStart: Date;
        decide: (spend: RuntimeLlmSpendSnapshot) => number | null;
    }): Promise<{ reservationId: string; tokens: number } | null>;
    /** Replaces a reservation with what the provider reported (the Run's cost reads the usage spans, not this). */
    settle(reservationId: string, actual: RuntimeLlmSettledUsage): Promise<void>;
    /** Drops a reservation whose call never happened or failed. */
    cancel(reservationId: string): Promise<void>;
    totalForRun(runId: string): Promise<number>;
}

/** What one settled call spent. Cache tokens are part of inputTokens. */
export interface RuntimeLlmSettledUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: string;
}

/**
 * The Runtime's LLM spend from the usage spans LLM.run writes (the source
 * Token Usage reads), priced per call at its tier with the org's overrides
 * (domain/llm-spend.ts). The budget counters are never read for cost.
 */
export interface RuntimeLlmSpendReader {
    /**
     * The org's Runtime spans in [start, end), only of `runIds` when given.
     * Undefined when this deployment cannot read them (no telemetry store or
     * price list here): the LLM part is then "not measured", never zero.
     */
    spendOf(query: { organizationId: string; start: Date; end: Date; runIds?: string[] }): Promise<RuntimeLlmSpendRow[] | undefined>;
}
export const RUNTIME_LLM_SPEND_READER = Symbol.for('RuntimeApi.LlmSpendReader');

/** Repositories configured for a team (to bound a team key's repo list). */
export interface RuntimeTeamRepositories {
    listRepositoryIds(input: OrgTeam): Promise<string[]>;
}

export const RUNTIME_WHO_CAN_ASK = ['maintainers', 'writers', 'anyone_in_org'] as const;
export type RuntimeWhoCanAsk = (typeof RUNTIME_WHO_CAN_ASK)[number];

export interface RuntimeRepositorySettingsRecord {
    repositoryId: string;
    /** The repo takes part in the Runtime (mode is not `off`); joining creates its environment. */
    pilot: boolean;
    whoCanAsk: RuntimeWhoCanAsk;
    /** When it runs (screen 2). Absent on rows written before the mode existed. */
    mode?: RuntimeMode;
    rules?: TriggerRule[];
    runOnAgentPullRequests?: boolean;
    runOnNewPushes?: boolean;
}

/** 👍/👎 on one tested path of a Run, one per user (screen 8). */
export type FindingFeedbackValue = 'up' | 'down';

export interface FindingFeedbackRecord {
    organizationId: string;
    runId: string;
    probeId: string;
    userId: string;
    value: FindingFeedbackValue;
    updatedAt: string;
}

/** `runtime_finding_feedback`, product Postgres, written by the API. */
export interface FindingFeedbackStore {
    listForRun(organizationId: string, runId: string): Promise<FindingFeedbackRecord[]>;
    /** `null` clears the user's vote. */
    set(input: Omit<FindingFeedbackRecord, 'value' | 'updatedAt'> & { value: FindingFeedbackValue | null }): Promise<void>;
}

export const RUNTIME_FINDING_FEEDBACK_STORE = Symbol.for('RuntimeApi.FindingFeedbackStore');

/**
 * A developer's "this change is intended" on a finding of a Run: one per
 * finding, with who marked it and when. A learning signal kept in the
 * product; it never changes the Run, its check or the comment, which say
 * what Kody measured.
 */
export interface FindingIntentRecord {
    organizationId: string;
    runId: string;
    probeId: string;
    userId: string;
    markedAt: string;
}

/** `runtime_finding_intent`, product Postgres, written by the API. */
export interface FindingIntentStore {
    listForRun(organizationId: string, runId: string): Promise<FindingIntentRecord[]>;
    /** Marks the finding (the latest marker wins); `intended: false` clears the mark. */
    set(input: Omit<FindingIntentRecord, 'markedAt'> & { intended: boolean }): Promise<void>;
}

export const RUNTIME_FINDING_INTENT_STORE = Symbol.for('RuntimeApi.FindingIntentStore');

/** `runtime_settings` and `runtime_repository_settings`, product Postgres (§8), written by the API. */
/** A repository whose Runtime runs without anyone asking (mode `rules`), and when its settings last changed. */
export interface AutomaticRepositoryRow {
    organizationId: string;
    repositoryId: string;
    /** ISO time of the settings row's last write: the mode may have been turned on then. */
    updatedAt: string;
}

/** Repositories in mode `rules`, across organizations: only the lost-webhook reconciler (a system job) reads it. */
export interface AutomaticRepositoriesReader {
    listAutomaticAcrossOrganizations(limit: number): Promise<AutomaticRepositoryRow[]>;
}

export interface RuntimeSettingsStore {
    getOrganization(organizationId: string): Promise<{ tokenBudgetPerDay: number | null } | null>;
    setTokenBudget(organizationId: string, tokenBudgetPerDay: number | null): Promise<void>;
    listRepositories(organizationId: string): Promise<RuntimeRepositorySettingsRecord[]>;
    upsertRepository(organizationId: string, settings: RuntimeRepositorySettingsRecord): Promise<void>;
}

/** An environment row of the product Postgres (`runtime_environments`, §8). */
export interface ProductEnvironment {
    environmentId: string;
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
    state: 'setup_requested' | 'active';
    setupRequestedAt?: string;
    /** The org admin keeps a failed default-branch setup's machines for diagnosis (§11 runbook). */
    diagnosticHold?: boolean;
    /** The org admin's warm pool size; null or absent: the plan's default. */
    poolSize?: number | null;
    /** The org admin's machine size for builds and services (contracts/machine-size.ts); null or absent: the cell's default. */
    machineSize?: MachineSizePreset | null;
    /** What a PR from a fork does (contracts/enums.ts); null or absent: require_approval. */
    forkPullRequests?: ForkPullRequestPolicy | null;
    /** When the machines are kept ready; null or absent: always (domain/pool.ts). */
    poolPolicy?: PoolPolicy | null;
    /** The last pull request event of the repository, for the policy's warm-up. */
    poolActivityAt?: string | null;
    /** The size the cell was last asked for; null: never asked. */
    poolAppliedSize?: number | null;
    /** This month's estimated machine-minutes kept ready. */
    poolUsage?: PoolUsage | null;
    /** The org's secrets in this environment's previews; absent: none (decision 4). */
    previewSecrets?: PreviewSecrets;
    createdAt: string;
    updatedAt: string;
}

/** What the org admin sets on one environment (PATCH /runtime/environments/:id/settings). */
export type ProductEnvironmentSettings = Partial<{
    diagnosticHold: boolean;
    machineSize: MachineSizePreset | null;
    forkPullRequests: ForkPullRequestPolicy;
    poolSize: number | null;
    poolPolicy: PoolPolicy | null;
    previewSecrets: PreviewSecrets;
}>;

/** Every read and write names the org: another org's environment reads as absent and is never written. */
export interface ProductEnvironmentStore {
    listByOrganization(organizationId: string): Promise<ProductEnvironment[]>;
    get(organizationId: string, environmentId: string): Promise<ProductEnvironment | null>;
    findByRepository(organizationId: string, repositoryId: string): Promise<ProductEnvironment | null>;
    /** Idempotent on (organizationId, repositoryId): returns the existing row when there is one. */
    create(input: Omit<ProductEnvironment, 'environmentId' | 'createdAt' | 'updatedAt' | 'state' | 'setupRequestedAt'>): Promise<ProductEnvironment>;
    markSetupRequested(organizationId: string, environmentId: string, at: Date): Promise<void>;
    /** The org admin's settings, written together in one update: a field left out keeps its value. */
    updateSettings(organizationId: string, environmentId: string, settings: ProductEnvironmentSettings): Promise<void>;
    markPoolActivity(organizationId: string, environmentId: string, at: Date): Promise<void>;
    /** What the cell was asked for and the month's usage, written together by the pool controller. */
    setPoolApplied(organizationId: string, environmentId: string, size: number, usage: PoolUsage): Promise<void>;
    /**
     * Every environment with a pool policy or a size asked of its cell, across organizations: only the
     * pool scheduler (a system job) reads it, and each row it acts on names its own org.
     */
    listPoolManagedAcrossOrganizations(limit: number): Promise<ProductEnvironment[]>;
}

/**
 * A repository of an environment (`runtime_environment_repositories`,
 * product Postgres): the `primary`, which is the environment's own
 * repository and holds the recipe, or a `member` booted beside it.
 */
export interface EnvironmentRepository {
    environmentId: string;
    organizationId: string;
    repositoryId: string;
    repositoryName: string;
    fullName: string;
    role: EnvironmentRepositoryRole;
    /** Its directory in the workspace (contracts/workspace.ts REPOSITORY_ALIAS_PATTERN), unique in the environment. */
    alias: string;
    /** A pull request of this repository starts a Run of this environment. */
    triggers: boolean;
    /** A Run boots this repository's open pull request of the same branch name instead of its default branch. */
    pairBranches: boolean;
    createdAt: string;
    updatedAt: string;
}

/** What may change on a repository of an environment; its role never does. */
export type EnvironmentRepositoryPatch = Partial<Pick<EnvironmentRepository, 'alias' | 'triggers' | 'pairBranches'>>;

/** The write would give the environment a second primary, an alias another of its repositories has, or more repositories than it may hold. */
export class EnvironmentRepositoryConflictError extends Error {
    constructor(readonly conflict: 'primary' | 'alias' | 'limit') {
        super(
            conflict === 'primary'
                ? 'The environment already has a primary repository'
                : conflict === 'alias'
                  ? 'Another repository of the environment has that alias'
                  : `An environment holds at most ${MAX_WORKSPACE_REPOSITORIES} repositories`,
        );
        this.name = 'EnvironmentRepositoryConflictError';
    }
}

/**
 * `runtime_environment_repositories`, written by the API. Every read and
 * write names the org: another org's environment has no repositories and is
 * never written.
 */
export interface EnvironmentRepositoryStore {
    /** The environment's repositories, the primary first, then by alias. */
    listByEnvironment(organizationId: string, environmentId: string): Promise<EnvironmentRepository[]>;
    /** Every environment the repository is part of, as its primary or a member. */
    listByRepository(organizationId: string, repositoryId: string): Promise<EnvironmentRepository[]>;
    /**
     * Adds the repository to the org's environment. Idempotent on (environment,
     * repository): an existing row is returned unchanged. Null when the
     * environment is not the org's. A second primary, an alias taken, or a
     * member past MAX_WORKSPACE_REPOSITORIES (the primary counted, even before
     * its row) throws EnvironmentRepositoryConflictError; adds that arrive
     * together never get past the cap.
     */
    add(input: Omit<EnvironmentRepository, 'createdAt' | 'updatedAt'>): Promise<EnvironmentRepository | null>;
    /** Removes a member; false when there is none, and for the primary, which leaves only with its environment. */
    remove(organizationId: string, environmentId: string, repositoryId: string): Promise<boolean>;
    /** Changes the given fields together; null when there is no such row. An alias taken throws EnvironmentRepositoryConflictError. */
    update(organizationId: string, environmentId: string, repositoryId: string, patch: EnvironmentRepositoryPatch): Promise<EnvironmentRepository | null>;
}

/** Repositories connected to the org (integration config of its team). */
export interface RuntimeOrgRepositories {
    list(organizationId: string): Promise<{ teamId: string; repositories: Array<{ repositoryId: string; repositoryName: string }> }>;
}

export interface EgressBlockedRow {
    host: string;
    port?: number;
    phase?: 'build' | 'test';
    count: number;
    lastAt?: string;
}

/** Read-only view of runtime_egress_events / runtime_egress_approvals (Runtime Postgres). */
/** Reads runtime_environment_setups (written by the runtime-worker only). */
export interface RuntimeEnvironmentSetupReader {
    /** The latest setup of that org's environment, or null. */
    get(organizationId: string, environmentId: string): Promise<EnvironmentSetupRecord | null>;
}

export const RUNTIME_ENVIRONMENT_SETUP_READER = Symbol.for('RuntimeApi.EnvironmentSetupReader');

/**
 * Reads runtime_build_state_evictions (written by the hub from each cell's
 * heartbeat): the cells whose disk floor removed the environment's build
 * state and that still say so. Ids and times only.
 */
export interface RuntimeBuildStateEvictionReader {
    evictions(organizationId: string, environmentId: string): Promise<Array<{ cellId: string; evictedAt: string }>>;
}

export const RUNTIME_BUILD_STATE_EVICTION_READER = Symbol.for('RuntimeApi.BuildStateEvictionReader');

/**
 * The agent runner of an org's Runtime work (ADR-057): the harness on the
 * org's LLM_TASK.runtime BYOK slot, resolved like the gateway resolves it. The
 * key stays in the slot until LLM.run builds the model; it never leaves the API.
 */
/**
 * What the usage span of each model call of a Runtime agent carries, so the
 * Run cost and the usage report attribute it (docs/runtime/usage-report.md):
 * the Run (or the setup's scope) it served and where.
 */
export interface RuntimeSpanAttribution {
    /** The Run's id, or the setup's learn scope (setupLearnScopeId) for the recipe author. */
    runId: string;
    task: string;
    repositoryId?: string;
    environmentId?: string;
    prNumber?: number;
}

export interface RuntimeAgentRunnerFactory {
    /** Null when the org has no LLM for the Runtime (no slot and no managed default). */
    forOrganization(orgTeam: OrgTeam, attribution?: RuntimeSpanAttribution): Promise<{ runner: AgentRunner; model?: string } | null>;
}

export const RUNTIME_AGENT_RUNNER_FACTORY = Symbol.for('RuntimeApi.AgentRunnerFactory');

/** runtime_lessons (ADR-018), written by the runtime-worker; the API only reads them. */
export interface RuntimeLessonReader {
    /** The org's active lessons; never another org's. */
    listByOrganization(organizationId: string): Promise<Lesson[]>;
}

export const RUNTIME_LESSON_READER = Symbol.for('RuntimeApi.LessonReader');

/** The provider is wired but cannot serve this org (no slot, no managed key): the gateway answers 503. */
export class LlmProviderUnavailableError extends Error {}

/** The org's calls kept moving the budget under this one: not reserved, try again (S-47). */
export class LlmBudgetBusyError extends Error {
    constructor() {
        super('The LLM budget of this organization is busy; try again');
    }
}

/** Kodus on-call users (RUNTIME_ONCALL_USER_IDS): global stop and managed cells. */
export const isKodusOncall = (config: Pick<RuntimeApiConfig, 'oncallUserIds'>, user: { uuid?: string } | undefined) =>
    !!user?.uuid && config.oncallUserIds.includes(user.uuid);

/** The claim rounds of Runs as the hub recorded them (runtime_claims), read only: what prices a Run's machine time. */
export interface RuntimeClaimUsageReader {
    /** By runId; a Run with no claim row is absent. Only rows of `organizationId`. */
    claimsOfRuns(organizationId: string, runIds: string[]): Promise<Map<string, RunClaimUsage[]>>;
}

/** The org's machine minutes of the current UTC day (runtime_machine_usage), read only; undefined without the read URL. */
/**
 * The Runtime Postgres rows the usage report reads (runtime_runs,
 * runtime_claims, runtime_environment_setups), with the read-only role inside
 * BEGIN READ ONLY (ADR-025); org-scoped, the filters in the query, bounded.
 */
export interface RuntimeUsageReportReader {
    /** The org's Runs requested in [start, end), newest first, at most `limit`; and how many there are in all. */
    runsOfMonth(organizationId: string, window: { start: Date; end: Date }, filters: UsageReportFilters, limit: number): Promise<{ runs: UsageRunRecord[]; total: number }>;
    /**
     * The claims of the Runs requested in the window (consumer runtime), and
     * every other claim created in it (setups, sandbox sessions, MCP, custom
     * agents), each at most `limit`; `truncated` when a limit cut one.
     */
    claimsOfMonth(organizationId: string, window: { start: Date; end: Date }, filters: UsageReportFilters, limit: number): Promise<{ claims: UsageClaimRecord[]; truncated: boolean }>;
    /** The org's sandbox operations audited in [start, end) (runtime_sandbox_audit). */
    sandboxOperationsOfMonth(organizationId: string, window: { start: Date; end: Date }): Promise<UsageSandboxOperations>;
}

export interface RuntimeMachineUsageReader {
    today(organizationId: string): Promise<RuntimeMachineUsageToday | undefined>;
}

/** One approval as the screens show it (docs/runtime/egress-allowlist.md §9). */
export interface EgressApprovalRow {
    host: string;
    approvedBy?: string;
    approvedAt?: string;
    /** inspected (GET/HEAD under pathPrefixes) or passthrough (full access; every approval before tiers). */
    mode?: 'inspected' | 'passthrough';
    pathPrefixes?: string[];
    source?: 'blocker' | 'settings';
    revokedAt?: string;
    revokedBy?: string;
    /** When a claim last got it (D5: approvals do not expire; this is their last use). */
    lastSentAt?: string;
}

/** One approval, revocation or settings change (runtime_egress_audit). */
export interface EgressAuditRow {
    action: 'approve' | 'revoke' | 'settings';
    environmentId?: string;
    host?: string;
    mode?: string;
    pathPrefixes?: string[];
    actor: string;
    source: string;
    sourceRef?: string;
    recommendedVersion?: number;
    reason?: string;
    at: string;
}

/** The org's outbound access settings (D2, D3); the defaults when never set. */
export interface EgressSettingsRow {
    recommendedEnabled: boolean;
    whoMayAdd: 'owners' | 'owners_and_repo_admins' | 'nobody';
    updatedBy?: string;
    updatedAt?: string;
}

export interface RuntimeEgressReader {
    blockedForRuns(organizationId: string, runIds: string[], since: Date): Promise<EgressBlockedRow[]>;
    /** The scope's approvals, revoked ones included (marked), newest first; ORG_EGRESS_SCOPE is the org list. */
    approvals(organizationId: string, environmentId: string): Promise<EgressApprovalRow[]>;
    /** The org's settings; never-set reads as the defaults (recommended on, owners only). */
    settings?(organizationId: string): Promise<EgressSettingsRow>;
    /** The audit, newest first, of one environment (or the org list) or of the whole org. */
    audit?(organizationId: string, environmentId?: string): Promise<EgressAuditRow[]>;
}

// The /mcp/env ports (Inc. 1) live beside their rules.
export * from './env-tools';

// External findings/task admission belongs to the product, never Runtime state.
export { RUNTIME_EXTERNAL_FINDINGS, RUNTIME_EXTERNAL_FINDINGS_STORE, RUNTIME_EXTERNAL_STOP_READER } from './external-findings';
export type { ExternalFindingsPort, ExternalFindingsStore, ExternalStopReader, ExternalTaskView } from './external-findings';
