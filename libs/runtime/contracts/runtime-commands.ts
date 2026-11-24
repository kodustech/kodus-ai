import { z } from 'zod';

import { TraceparentSchema } from './trace-context';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { ENVIRONMENT_REPOSITORY_ROLES, RECIPE_FILE_PATHS } from '@libs/runtime/contracts/enums';
import { EGRESS_APPROVAL_MODES, EGRESS_WHO_MAY_ADD } from '@libs/runtime/contracts/egress';
import { EgressHostSchema, SealedTokenSchema } from '@libs/runtime/contracts/boundary-values';
import { MachineSizeSchema } from '@libs/runtime/contracts/machine-size';
import { MAX_WORKSPACE_REPOSITORIES, RepositoryAliasSchema, RepositoryFullNameSchema, workspaceShapeError } from '@libs/runtime/contracts/workspace';
import { RUNTIME_CONTROL_ROUTING_KEY, RUNTIME_EXCHANGE, RUNTIME_RUN_ROUTING_KEY, RuntimeEventName, runtimeEnvelope } from '@libs/runtime/run/run-messages';
import { isSealedSecret } from '@libs/runtime/run/sealed-secret';

// Decisions taken in the product that change Runtime state. Only the Runtime
// writes its database, so the API never writes the tables (runtime_fork_approvals, runtime_egress_approvals,
// runtime_cell_tokens, runtime_cell_revocations): it records the decision as an
// outbox row in the same envelope as RuntimeRunRequested, and the
// runtime-worker applies it idempotently. runtimeCommandRoute picks the queue:
// an environment setup (work, like a Run) goes on the runtime_run queue, every
// other command on workflow.jobs.runtime_control.queue, so a stop or an
// approval never waits behind queued Runs.

export const RuntimeCommandName = {
    ForkApproved: 'runtime.run.fork_approved',
    EgressApproved: 'runtime.environment.egress_approved',
    EgressRevoked: 'runtime.environment.egress_revoked',
    EgressSettingsChanged: 'runtime.org.egress_settings_changed',
    MachineMinutesChanged: 'runtime.org.machine_minutes_changed',
    StopRequested: 'runtime.stop.requested',
    StopCleared: 'runtime.stop.cleared',
    EnvironmentSetupRequested: 'runtime.environment.setup_requested',
    EnvironmentPoolRequested: 'runtime.environment.pool_requested',
    CellTokenIssued: 'runtime.cell.registration_token_issued',
    CellTokenRevoked: 'runtime.cell.registration_token_revoked',
    CellRevokeRequested: 'runtime.cell.revoke_requested',
    LessonUpdateRequested: 'runtime.lesson.update_requested',
    OrganizationPurgeRequested: 'runtime.organization.purge_requested',
    SuiteRequested: 'runtime.suite.requested',
    SuiteRetried: 'runtime.suite.retried',
} as const;
export type RuntimeCommandEventName = (typeof RuntimeCommandName)[keyof typeof RuntimeCommandName];

const id = z.string().min(1).max(128);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const actor = z.strictObject({ userId: id, email: z.string().max(320).optional() });
const sealedToken = SealedTokenSchema;

export const RuntimeForkApprovedSchema = z.strictObject({
    runId: z.uuid(),
    attempt: z.number().int().min(1),
    organizationId: id,
    repositoryId: id,
    prNumber: z.number().int().min(1),
    /** The head the approver saw; a new push needs a new approval. */
    headSha: sha,
    approver: z.strictObject({
        userId: id,
        gitUserId: z.string().max(128).optional(),
        gitLogin: z.string().max(256).optional(),
    }),
    approvedAt: z.iso.datetime(),
    /**
     * Fresh repo and Run tokens, sealed for this runId: the ones the Run was
     * requested with expire while it waits (the repo token in 1 h).
     * `workspace`: the fresh tokens of every other repository of a
     * multi-repository Run (each side's, by repositoryId); a repository the
     * approval leaves out has no token any more, and its claims are refused
     * naming it rather than booting with an expired one.
     */
    tokens: z
        .strictObject({
            repoToken: sealedToken,
            prRepoToken: sealedToken.optional(),
            runToken: sealedToken,
            workspace: z
                .array(z.strictObject({ repositoryId: id, sealedRepoToken: sealedToken, sealedPrRepoToken: sealedToken.optional() }))
                .min(1)
                .max(MAX_WORKSPACE_REPOSITORIES)
                .optional(),
        })
        .optional(),
    /** Idempotency key `runId:headSha`. */
    key: z.string().min(1).max(256),
});
export type RuntimeForkApproved = z.infer<typeof RuntimeForkApprovedSchema>;
/** The fresh sealed tokens a fork approval brings. */
export type ForkApprovalTokens = NonNullable<RuntimeForkApproved['tokens']>;

const egressPath = z.string().min(1).max(256).regex(/^\/[\x21-\x7e]*$/);

// mode, pathPrefixes, source and sourceRef are optional so a worker before
// them still takes an approval (as passthrough, as every approval was).
export const RuntimeEgressApprovedSchema = z.strictObject({
    /** An environment, or ORG_EGRESS_SCOPE for the org list. */
    environmentId: id,
    organizationId: id,
    host: EgressHostSchema,
    approvedBy: actor,
    approvedAt: z.iso.datetime(),
    mode: z.enum(EGRESS_APPROVAL_MODES).optional(),
    /** For mode inspected: the path prefixes a GET or HEAD may name. */
    pathPrefixes: z.array(egressPath).min(1).max(16).optional(),
    /** Where it was approved from: the blocker card or the settings screen. */
    source: z.enum(['blocker', 'settings']).optional(),
    /** The blocker signature with its setup or Run id, for the audit. */
    sourceRef: z.string().min(1).max(256).optional(),
    reason: z.string().min(1).max(500).optional(),
    /** Idempotency key `environmentId:host` (unique in runtime_egress_approvals). */
    key: z.string().min(1).max(400),
}).refine((b) => b.mode !== 'inspected' || (b.pathPrefixes?.length ?? 0) > 0, { message: 'an inspected approval names its path prefixes', path: ['pathPrefixes'] });
export type RuntimeEgressApproved = z.infer<typeof RuntimeEgressApprovedSchema>;

/** An approval revoked (G3): its live claims get the list without it, which cuts their connections to the host. */
export const RuntimeEgressRevokedSchema = z.strictObject({
    /** An environment, or ORG_EGRESS_SCOPE for the org list. */
    environmentId: id,
    organizationId: id,
    host: EgressHostSchema,
    revokedBy: actor,
    revokedAt: z.iso.datetime(),
    reason: z.string().min(1).max(500).optional(),
    key: z.string().min(1).max(400),
});
export type RuntimeEgressRevoked = z.infer<typeof RuntimeEgressRevokedSchema>;

/** The org's outbound access settings (D2, D3): the Kodus recommended list on or off, and who may add hosts. */
export const RuntimeEgressSettingsChangedSchema = z.strictObject({
    organizationId: id,
    recommendedEnabled: z.boolean(),
    whoMayAdd: z.enum(EGRESS_WHO_MAY_ADD),
    changedBy: actor,
    changedAt: z.iso.datetime(),
    key: z.string().min(1).max(400),
});
export type RuntimeEgressSettingsChanged = z.infer<typeof RuntimeEgressSettingsChangedSchema>;

/**
 * The org's own daily machine minutes (spec v18 PR 2, PATCH /runtime/settings machineMinutesPerDay): it lowers the
 * deployment's RUNTIME_MACHINE_MINUTES_PER_ORG_DAY for the org, never raises it; null = the deployment's limit.
 * Bounded like MAX_ORG_MACHINE_MINUTES_PER_DAY (libs/runtime/environment/machine-minutes.ts).
 */
export const RuntimeMachineMinutesChangedSchema = z.strictObject({
    organizationId: id,
    minutesPerDay: z.number().int().positive().max(14_400_000).nullable(),
    changedBy: actor,
    changedAt: z.iso.datetime(),
    key: z.string().min(1).max(400),
});
export type RuntimeMachineMinutesChanged = z.infer<typeof RuntimeMachineMinutesChangedSchema>;

const stopCommon = {
    requestedBy: actor,
    requestedAt: z.iso.datetime(),
    correlationId: z.string().min(1).max(128),
};
/** `org` names the org it stops; `global` names none. */
export const RuntimeStopRequestedSchema = z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('org'), organizationId: id, ...stopCommon }),
    z.strictObject({ scope: z.literal('global'), ...stopCommon }),
]);
export type RuntimeStopRequested = z.infer<typeof RuntimeStopRequestedSchema>;

/**
 * Clears the active stops of one scope requested at or before `clearedAt`; a
 * stop requested after the clear stays (the outbox can reorder retries).
 */
const clearCommon = {
    clearedBy: actor,
    clearedAt: z.iso.datetime(),
    correlationId: z.string().min(1).max(128),
};
export const RuntimeStopClearedSchema = z.discriminatedUnion('scope', [
    z.strictObject({ scope: z.literal('org'), organizationId: id, ...clearCommon }),
    z.strictObject({ scope: z.literal('global'), ...clearCommon }),
]);
export type RuntimeStopCleared = z.infer<typeof RuntimeStopClearedSchema>;

/** Where the recipe lives, always read from the default branch. */
export const RUNTIME_RECIPE_PATH = RECIPE_FILE_PATHS[1];
/**
 * A recipe for the Runtime only, read before RUNTIME_RECIPE_PATH: a repo whose
 * workspace.yaml is a dev recipe (Runo, with files.copy of .env) keeps it and
 * gives the Runtime one with fakes instead.
 */
export const RUNTIME_ONLY_RECIPE_PATH = RECIPE_FILE_PATHS[0];
export const RUNTIME_RECIPE_PATHS = RECIPE_FILE_PATHS;
export const RUNTIME_RECIPE_MAX_BYTES = 65_536;

/**
 * Why the product could not hand the setup a commit, a download token or the
 * recipe. The runtime-worker records it as the setup's blocker (it never
 * guesses a commit); `RUNTIME_SETUP_DEV_SHA` is the only explicit override.
 */
export const SETUP_REQUEST_BLOCKER_KINDS = [
    'no_ref',
    'unsupported_platform',
    'git_unavailable',
    'token_unavailable',
    'recipe_unreadable',
    'recipe_invalid',
    'resources',
] as const;
export type SetupRequestBlockerKind = (typeof SETUP_REQUEST_BLOCKER_KINDS)[number];

/**
 * Where a setup's recipe came from: the default branch, or written by Kodus
 * from the repository files because the default branch has none (the
 * deterministic first step of the learning loop).
 */
export const RECIPE_ORIGINS = ['repository', 'inferred'] as const;
export type RecipeOrigin = (typeof RECIPE_ORIGINS)[number];
/**
 * Where the recipe a setup booted with came from: the command's origins, or
 * `authored`: the default branch had none, the inference could not write one,
 * and Kody's agent wrote it in the API during the setup. Only the worker
 * records it (never in the command), from the product's answer.
 */
export type SetupRecipeOrigin = RecipeOrigin | 'authored';
/** Why Kodus could not infer a recipe: nothing to boot from, a compose file it cannot read, or no HTTP port to call. */
export const RECIPE_INFERENCE_GAPS = ['no_build_files', 'compose_unreadable', 'no_http_port', 'published_image'] as const;
export type RecipeInferenceGap = (typeof RECIPE_INFERENCE_GAPS)[number];

/**
 * One repository of a multi-repository setup: the default-branch head it
 * builds (read by the product from the Git API, like `ref`) and a download
 * token for that repository only, sealed for this setup (bound to `key`).
 */
export const SetupWorkspaceRepositorySchema = z.strictObject({
    repositoryId: id,
    fullName: RepositoryFullNameSchema,
    alias: RepositoryAliasSchema,
    role: z.enum(ENVIRONMENT_REPOSITORY_ROLES),
    sha,
    branch: z.string().min(1).max(256),
    sealedRepoToken: sealedToken,
});
export type SetupWorkspaceRepository = z.infer<typeof SetupWorkspaceRepositorySchema>;

/**
 * Why a setup's workspace disagrees with the rest of the command, or
 * undefined: its primary is the command's repository at the command's ref.
 */
function setupWorkspaceError(m: { repositoryId: string; ref?: { sha: string }; workspace?: SetupWorkspaceRepository[] }): string | undefined {
    if (!m.workspace) return undefined;
    const shape = workspaceShapeError(m.workspace);
    if (shape) return shape;
    const primary = m.workspace.find((r) => r.role === 'primary')!;
    if (primary.repositoryId !== m.repositoryId) return "the workspace's primary is the setup's repository";
    if (m.ref && primary.sha !== m.ref.sha) return "the workspace's primary builds the setup's ref";
    return undefined;
}

/** The product asks the Runtime to (re)build an environment's image from its recipe. */
export const RuntimeEnvironmentSetupRequestedSchema = z.strictObject({
    environmentId: id,
    organizationId: id,
    teamId: id,
    repositoryId: id,
    repositoryName: z.string().min(1).max(512),
    requestedBy: actor,
    requestedAt: z.iso.datetime(),
    /** Idempotency key `environmentId:requestedAt`. */
    key: z.string().min(1).max(256),
    /**
     * The W3C trace the product asked in (the API call or the pool cron): the
     * setup's spans continue it. Deploy the runtime-worker first: an older
     * worker's strict schema refuses the field.
     */
    traceparent: TraceparentSchema.optional(),
    /**
     * The commit to build: the default branch head, read by the product from
     * the Git API. With `branch`, the worker may ask for an image
     * bake of it; without it (dev fallback) it never bakes.
     */
    ref: z.strictObject({ sha, branch: z.string().min(1).max(256).optional() }).optional(),
    repositoryFullName: z.string().max(512).optional(),
    /** Download token for this repo only, like RuntimeRunRequested.repoToken, sealed for this setup (bound to `key`). */
    repoToken: z
        .string()
        .min(1)
        .max(8_192)
        .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' })
        .optional(),
    /**
     * The setup token for the product's LLM gateway, sealed for this
     * setup (bound to `key`): Kody's learn loop runs only with it. Absent when
     * the product has no run token secret; the loop is then off.
     */
    llmToken: z
        .string()
        .min(1)
        .max(8_192)
        .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' })
        .optional(),
    /** The org admin turned on the diagnostic hold for this environment. */
    diagnosticHold: z.boolean().optional(),
    /** Warm pool machines to keep ready once the bake is accepted (plan default or the admin's choice, under the plan's ceiling). */
    poolSize: z.number().int().min(0).max(100).optional(),
    /**
     * The environment's machine size (its setting's preset): the memory and
     * CPUs of the setup's builds and services, and of every Run and session
     * on what it booted. Absent: the cell's default.
     */
    machineSize: MachineSizeSchema.optional(),
    /**
     * `.kodus/workspace.yaml` at `ref.sha` (the recipe is read from the
     * default branch, never from a PR). `content: null` = the default branch
     * has no recipe. Absent = the product did not read it (a blocker came first).
     * `origin: 'inferred'`: the default branch had none and `content` is the
     * recipe Kodus wrote from its files; `inference`: why it could not write one.
     */
    recipe: z
        .strictObject({
            path: z.enum(RUNTIME_RECIPE_PATHS),
            sha,
            content: z.string().max(RUNTIME_RECIPE_MAX_BYTES).nullable(),
            origin: z.enum(RECIPE_ORIGINS).optional(),
            inference: z.strictObject({ reason: z.enum(RECIPE_INFERENCE_GAPS), message: z.string().min(1).max(500) }).optional(),
        })
        .refine((r) => r.origin !== 'inferred' || (r.content !== null && r.path === RUNTIME_RECIPE_PATH && !r.inference), {
            message: 'an inferred recipe carries its text, at the shared path',
        })
        .refine((r) => !r.inference || r.content === null, { message: 'an inference gap goes with no recipe text' })
        .optional(),
    /**
     * `template:<org>/<env>`: this setup builds the environment's template (docs/runtime/host-providers.md §8.2) and
     * is placed only on the cell bound to that key. Absent: an ordinary setup.
     */
    boundKey: z.string().regex(/^template:[^/]+\/[^/]+$/).max(300).optional(),
    /** Set when the product could not resolve what the setup needs; the worker records it and boots nothing. */
    blocker: z.strictObject({ kind: z.enum(SETUP_REQUEST_BLOCKER_KINDS), message: z.string().min(1).max(500) }).optional(),
    /**
     * Every repository of a multi-repository environment, the primary
     * included, each at its default-branch head with its own token. Absent
     * for an environment of one repository, which builds `ref` with
     * `repoToken` as before.
     */
    workspace: z.array(SetupWorkspaceRepositorySchema).min(1).max(MAX_WORKSPACE_REPOSITORIES).optional(),
}).superRefine((m, ctx) => {
    const error = setupWorkspaceError(m);
    if (error) ctx.addIssue({ code: 'custom', message: error, path: ['workspace'] });
});
export type RuntimeEnvironmentSetupRequested = z.infer<typeof RuntimeEnvironmentSetupRequestedSchema>;

/** The admin changed an environment's warm pool size: the worker asks the environment's cell for it (pool.target). */
export const RuntimeEnvironmentPoolRequestedSchema = z.strictObject({
    environmentId: id,
    organizationId: id,
    /** The size the cell is asked for, already bounded by the plan. */
    size: z.number().int().min(0).max(100),
    requestedBy: actor,
    requestedAt: z.iso.datetime(),
    /** Idempotency key `environmentId:pool:requestedAt`. */
    key: z.string().min(1).max(256),
});
export type RuntimeEnvironmentPoolRequested = z.infer<typeof RuntimeEnvironmentPoolRequestedSchema>;

export const RuntimeCellTokenIssuedSchema = z.strictObject({
    /** SHA-256 hex of the token; the token itself never leaves the response to the admin. */
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    organizationId: id,
    topology: z.enum(['hybrid', 'self_hosted']),
    expiresAt: z.iso.datetime(),
    issuedBy: actor,
});
export type RuntimeCellTokenIssued = z.infer<typeof RuntimeCellTokenIssuedSchema>;

/** An org owner revoked an unused registration token of the org; a used one stays used (its cell is revoked as a cell). */
export const RuntimeCellTokenRevokedSchema = z.strictObject({
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
    organizationId: id,
    revokedBy: actor,
    revokedAt: z.iso.datetime(),
});
export type RuntimeCellTokenRevoked = z.infer<typeof RuntimeCellTokenRevokedSchema>;

export const RuntimeCellRevokeRequestedSchema = z.strictObject({
    cellId: id,
    /** Owner org of a customer cell; absent for a managed cell (on-call). */
    organizationId: id.optional(),
    requestedBy: actor,
    requestedAt: z.iso.datetime(),
    reason: z.string().max(500).optional(),
});
export type RuntimeCellRevokeRequested = z.infer<typeof RuntimeCellRevokeRequestedSchema>;

/**
 * An org admin acts on a lesson: `promote` makes a repo lesson
 * apply to every repo of the org; `retire` stops it from being used.
 */
export const RuntimeLessonUpdateRequestedSchema = z.strictObject({
    lessonId: z.string().regex(/^[0-9a-f]{32}$/),
    organizationId: id,
    action: z.enum(['promote', 'retire']),
    requestedBy: actor,
    requestedAt: z.iso.datetime(),
});
export type RuntimeLessonUpdateRequested = z.infer<typeof RuntimeLessonUpdateRequestedSchema>;

/**
 * Every Runtime datum of one organization leaves the Runtime: its Postgres rows and its evidence objects, after its
 * live Runs are cancelled and its claims released. Sent when the product deletes the organization and by the owner's
 * explicit purge; the worker applies it idempotently (a second one finds nothing and ends). The product's own
 * Postgres rows and the OpenBao secret values are the API's to delete, before this is sent.
 */
export const RuntimeOrganizationPurgeRequestedSchema = z.strictObject({
    organizationId: id,
    requestedBy: actor.optional(),
    requestedAt: z.iso.datetime(),
    /** Why: the organization was deleted, or its owner asked. */
    reason: z.enum(['organization_deleted', 'owner_requested']),
});
export type RuntimeOrganizationPurgeRequested = z.infer<typeof RuntimeOrganizationPurgeRequestedSchema>;

/** How a suite run starts (docs/runtime/e2e-suites.md section 11): a Run's stage, a CI check, or the baseline of a main commit. */
export const SUITE_MODES = ['run', 'ci', 'baseline'] as const;
export type SuiteMode = (typeof SUITE_MODES)[number];

/**
 * Starts one run of the repository's own e2e suite. `suiteRunId` is the idempotency identity (a second delivery
 * finds the run and starts nothing). A baseline names the main commit alone; a PR suite also names its PR, its head
 * and the merge base (the commit the selection and the baseline lookup start from).
 */
export const RuntimeSuiteRequestedSchema = z
    .strictObject({
        suiteRunId: z.uuid(),
        organizationId: id,
        environmentId: id,
        repositoryId: id,
        mode: z.enum(SUITE_MODES),
        prNumber: z.number().int().min(1).optional(),
        prSha: sha.optional(),
        mergeBase: sha.optional(),
        /** The default-branch head the environment template was built from: the main side of every comparison. */
        mainSha: sha,
        requestedAt: z.iso.datetime(),
        /** Idempotency key `suiteRunId`. */
        key: z.string().min(1).max(256),
        traceparent: TraceparentSchema.optional(),
        /** Download token for the repository, sealed for this suite run (bound to `key`), like a setup's. */
        repoToken: z
            .string()
            .min(1)
            .max(8_192)
            .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' })
            .optional(),
    })
    .superRefine((m, ctx) => {
        const pr = [m.prNumber, m.prSha, m.mergeBase];
        if (m.mode === 'baseline') {
            if (pr.some((v) => v !== undefined)) ctx.addIssue({ code: 'custom', message: 'a baseline names the main commit alone', path: ['mode'] });
            return;
        }
        for (const [name, v] of [['prNumber', m.prNumber], ['prSha', m.prSha], ['mergeBase', m.mergeBase]] as const) {
            if (v === undefined) ctx.addIssue({ code: 'custom', message: `a ${m.mode} suite run names its ${name}`, path: [name] });
        }
    });
export type RuntimeSuiteRequested = z.infer<typeof RuntimeSuiteRequestedSchema>;

/** A person asks to run one shard of a suite again, or every spec that failed in it. */
export const RuntimeSuiteRetriedSchema = z
    .strictObject({
        suiteRunId: z.uuid(),
        organizationId: id,
        scope: z.enum(['shard', 'failed']),
        shard: z.number().int().min(0).max(63).optional(),
        requestedBy: actor,
        requestedAt: z.iso.datetime(),
        key: z.string().min(1).max(256),
    })
    .refine((m) => (m.scope === 'shard') === (m.shard !== undefined), { message: 'a shard retry names its shard; a failed-specs retry names none', path: ['shard'] });
export type RuntimeSuiteRetried = z.infer<typeof RuntimeSuiteRetriedSchema>;

/** The payload of each command, by its name. */
export interface RuntimeCommandPayloads {
    'runtime.run.fork_approved': RuntimeForkApproved;
    'runtime.environment.egress_approved': RuntimeEgressApproved;
    'runtime.environment.egress_revoked': RuntimeEgressRevoked;
    'runtime.org.egress_settings_changed': RuntimeEgressSettingsChanged;
    'runtime.org.machine_minutes_changed': RuntimeMachineMinutesChanged;
    'runtime.stop.requested': RuntimeStopRequested;
    'runtime.stop.cleared': RuntimeStopCleared;
    'runtime.environment.setup_requested': RuntimeEnvironmentSetupRequested;
    'runtime.environment.pool_requested': RuntimeEnvironmentPoolRequested;
    'runtime.cell.registration_token_issued': RuntimeCellTokenIssued;
    'runtime.cell.registration_token_revoked': RuntimeCellTokenRevoked;
    'runtime.cell.revoke_requested': RuntimeCellRevokeRequested;
    'runtime.lesson.update_requested': RuntimeLessonUpdateRequested;
    'runtime.organization.purge_requested': RuntimeOrganizationPurgeRequested;
    'runtime.suite.requested': RuntimeSuiteRequested;
    'runtime.suite.retried': RuntimeSuiteRetried;
}

const SCHEMAS: Record<RuntimeCommandEventName, z.ZodType> = {
    [RuntimeCommandName.ForkApproved]: RuntimeForkApprovedSchema,
    [RuntimeCommandName.EgressApproved]: RuntimeEgressApprovedSchema,
    [RuntimeCommandName.EgressRevoked]: RuntimeEgressRevokedSchema,
    [RuntimeCommandName.EgressSettingsChanged]: RuntimeEgressSettingsChangedSchema,
    [RuntimeCommandName.MachineMinutesChanged]: RuntimeMachineMinutesChangedSchema,
    [RuntimeCommandName.StopRequested]: RuntimeStopRequestedSchema,
    [RuntimeCommandName.StopCleared]: RuntimeStopClearedSchema,
    [RuntimeCommandName.EnvironmentSetupRequested]: RuntimeEnvironmentSetupRequestedSchema,
    [RuntimeCommandName.EnvironmentPoolRequested]: RuntimeEnvironmentPoolRequestedSchema,
    [RuntimeCommandName.CellTokenIssued]: RuntimeCellTokenIssuedSchema,
    [RuntimeCommandName.CellTokenRevoked]: RuntimeCellTokenRevokedSchema,
    [RuntimeCommandName.CellRevokeRequested]: RuntimeCellRevokeRequestedSchema,
    [RuntimeCommandName.LessonUpdateRequested]: RuntimeLessonUpdateRequestedSchema,
    [RuntimeCommandName.OrganizationPurgeRequested]: RuntimeOrganizationPurgeRequestedSchema,
    [RuntimeCommandName.SuiteRequested]: RuntimeSuiteRequestedSchema,
    [RuntimeCommandName.SuiteRetried]: RuntimeSuiteRetriedSchema,
};

/**
 * The events that go on the Run queue: a Run request, its cancel (so a cancel
 * never passes the request it cancels) and a setup, which is work like a Run.
 * Every other command is control (stop, revoke, approvals, pool) and has a
 * queue of its own, so a stop never waits behind a backlog of Run requests.
 */
const RUN_LANE_EVENTS: ReadonlySet<string> = new Set([
    RuntimeEventName.RunRequested,
    RuntimeEventName.RunCancelRequested,
    RuntimeCommandName.EnvironmentSetupRequested,
    // A suite is work like a Run and a setup: it waits in their lane, never in front of a stop.
    RuntimeCommandName.SuiteRequested,
    RuntimeCommandName.SuiteRetried,
]);

/** Whether an event (a Run message or a command) belongs on the Run queue rather than the control queue. */
export const isRunLaneEvent = (eventName: string): boolean => RUN_LANE_EVENTS.has(eventName);

export const runtimeCommandRoute = (eventName: RuntimeCommandEventName) =>
    isRunLaneEvent(eventName)
        ? { routingKey: RUNTIME_RUN_ROUTING_KEY, workflowType: WorkflowType.RUNTIME_RUN }
        : { routingKey: RUNTIME_CONTROL_ROUTING_KEY, workflowType: WorkflowType.RUNTIME_CONTROL };

/** Validates the payload and builds the outbox row (no job, full payload, like SANDBOX_INVALIDATE). */
export function runtimeCommandOutboxMessage<E extends RuntimeCommandEventName>(eventName: E, payload: RuntimeCommandPayloads[E], messageId: string) {
    const parsed = SCHEMAS[eventName].parse(payload) as Record<string, unknown>;
    const route = runtimeCommandRoute(eventName);
    return {
        jobId: undefined,
        exchange: RUNTIME_EXCHANGE,
        routingKey: route.routingKey,
        payload: runtimeEnvelope(eventName, { ...parsed, workflowType: route.workflowType }, messageId) as unknown as Record<
            string,
            unknown
        >,
    };
}
