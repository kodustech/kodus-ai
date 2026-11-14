import { z } from 'zod';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { RECIPE_FILE_PATHS } from '@libs/runtime/contracts/enums';
import { MachineSizeSchema } from '@libs/runtime/contracts/machine-size';
import { RUNTIME_CONTROL_ROUTING_KEY, RUNTIME_EXCHANGE, RUNTIME_RUN_ROUTING_KEY, runtimeEnvelope } from '@libs/runtime/run/run-messages';
import { isSealedSecret } from '@libs/runtime/run/sealed-secret';

// Decisions taken in the product that change Runtime state. ADR-025 keeps the
// Runtime database written only by the Runtime, so the API never writes the
// §8 tables (runtime_fork_approvals, runtime_egress_approvals,
// runtime_cell_tokens, runtime_cell_revocations): it records the decision as an
// outbox row on the runtime_run queue, in the same envelope as
// RuntimeRunRequested, and the runtime-worker applies it idempotently.

export const RuntimeCommandName = {
    ForkApproved: 'runtime.run.fork_approved',
    EgressApproved: 'runtime.environment.egress_approved',
    StopRequested: 'runtime.stop.requested',
    StopCleared: 'runtime.stop.cleared',
    EnvironmentSetupRequested: 'runtime.environment.setup_requested',
    EnvironmentPoolRequested: 'runtime.environment.pool_requested',
    CellTokenIssued: 'runtime.cell.registration_token_issued',
    CellRevokeRequested: 'runtime.cell.revoke_requested',
    LessonUpdateRequested: 'runtime.lesson.update_requested',
} as const;
export type RuntimeCommandEventName = (typeof RuntimeCommandName)[keyof typeof RuntimeCommandName];

const id = z.string().min(1).max(128);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const actor = z.strictObject({ userId: id, email: z.string().max(320).optional() });
const sealedToken = z
    .string()
    .min(1)
    .max(8_192)
    .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' });

export const RuntimeForkApprovedSchema = z.strictObject({
    runId: z.uuid(),
    attempt: z.number().int().min(1),
    organizationId: id,
    repositoryId: id,
    prNumber: z.number().int().min(1),
    /** The head the approver saw; a new push needs a new approval (ADR-030). */
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
     */
    tokens: z.strictObject({ repoToken: sealedToken, prRepoToken: sealedToken.optional(), runToken: sealedToken }).optional(),
    /** Idempotency key `runId:headSha`. */
    key: z.string().min(1).max(256),
});
export type RuntimeForkApproved = z.infer<typeof RuntimeForkApprovedSchema>;

export const RuntimeEgressApprovedSchema = z.strictObject({
    environmentId: id,
    organizationId: id,
    host: z.string().min(1).max(253),
    approvedBy: actor,
    approvedAt: z.iso.datetime(),
    /** Idempotency key `environmentId:host` (unique in runtime_egress_approvals). */
    key: z.string().min(1).max(400),
});
export type RuntimeEgressApproved = z.infer<typeof RuntimeEgressApprovedSchema>;

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

/** Where the recipe lives (docs §6), always read from the default branch. */
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
 * deterministic first step of the learning loop, docs §4 "Ciclo de aprender").
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
     * The commit to build: the default branch head, read by the product from
     * the Git API (ADR-057). With `branch`, the worker may ask for an image
     * bake of it (S-52); without it (dev fallback) it never bakes.
     */
    ref: z.strictObject({ sha, branch: z.string().min(1).max(256).optional() }).optional(),
    repositoryFullName: z.string().max(512).optional(),
    /** Download token for this repo only, like RuntimeRunRequested.repoToken (ADR-002), sealed for this setup (bound to `key`). */
    repoToken: z
        .string()
        .min(1)
        .max(8_192)
        .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' })
        .optional(),
    /**
     * The setup token for the product's LLM gateway (ADR-057), sealed for this
     * setup (bound to `key`): Kody's learn loop runs only with it. Absent when
     * the product has no run token secret; the loop is then off.
     */
    llmToken: z
        .string()
        .min(1)
        .max(8_192)
        .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' })
        .optional(),
    /** The org admin turned on the diagnostic hold for this environment (§11 runbook). */
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
     * `.kodus/workspace.yaml` at `ref.sha` (§6: the recipe is read from the
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
    /** Set when the product could not resolve what the setup needs; the worker records it and boots nothing. */
    blocker: z.strictObject({ kind: z.enum(SETUP_REQUEST_BLOCKER_KINDS), message: z.string().min(1).max(500) }).optional(),
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
 * An org admin acts on a lesson (ADR-018): `promote` makes a repo lesson
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

/** The payload of each command, by its name. */
export interface RuntimeCommandPayloads {
    'runtime.run.fork_approved': RuntimeForkApproved;
    'runtime.environment.egress_approved': RuntimeEgressApproved;
    'runtime.stop.requested': RuntimeStopRequested;
    'runtime.stop.cleared': RuntimeStopCleared;
    'runtime.environment.setup_requested': RuntimeEnvironmentSetupRequested;
    'runtime.environment.pool_requested': RuntimeEnvironmentPoolRequested;
    'runtime.cell.registration_token_issued': RuntimeCellTokenIssued;
    'runtime.cell.revoke_requested': RuntimeCellRevokeRequested;
    'runtime.lesson.update_requested': RuntimeLessonUpdateRequested;
}

const SCHEMAS: Record<RuntimeCommandEventName, z.ZodType> = {
    [RuntimeCommandName.ForkApproved]: RuntimeForkApprovedSchema,
    [RuntimeCommandName.EgressApproved]: RuntimeEgressApprovedSchema,
    [RuntimeCommandName.StopRequested]: RuntimeStopRequestedSchema,
    [RuntimeCommandName.StopCleared]: RuntimeStopClearedSchema,
    [RuntimeCommandName.EnvironmentSetupRequested]: RuntimeEnvironmentSetupRequestedSchema,
    [RuntimeCommandName.EnvironmentPoolRequested]: RuntimeEnvironmentPoolRequestedSchema,
    [RuntimeCommandName.CellTokenIssued]: RuntimeCellTokenIssuedSchema,
    [RuntimeCommandName.CellRevokeRequested]: RuntimeCellRevokeRequestedSchema,
    [RuntimeCommandName.LessonUpdateRequested]: RuntimeLessonUpdateRequestedSchema,
};

/**
 * The commands that go on the Run queue: a setup is work, like a Run. Every
 * other command is control (stop, revoke, approvals, pool) and has a queue of
 * its own, so a stop never waits behind a backlog of Run requests.
 */
const ON_RUN_QUEUE: ReadonlySet<RuntimeCommandEventName> = new Set([RuntimeCommandName.EnvironmentSetupRequested]);

export const runtimeCommandRoute = (eventName: RuntimeCommandEventName) =>
    ON_RUN_QUEUE.has(eventName)
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
