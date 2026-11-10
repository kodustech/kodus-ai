import { z } from 'zod';

import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

import { ExternalVerificationSchema } from '@libs/runtime/contracts/external-findings';
import { AuthoredFilesSchema } from '@libs/runtime/contracts/authored-files';
import { CHECK_CONCLUSIONS, ExposeSchema, MAX_RECIPE_CHANGED_PATHS, RECIPE_CHANGED_PATH, RUN_TRIGGERS } from '@libs/runtime/contracts/enums';
import { MachineSizeSchema } from '@libs/runtime/contracts/machine-size';
import { DIFF_TRUNCATED_MARKER_PATH } from '@libs/runtime/entry-points/extract';

import { type CommentPhase, RuntimeRunProgressSchema, RuntimeRunReportSchema } from './run-report';
import { isSealedSecret } from './sealed-secret';

// Messages between the product and the Runtime (docs §7). Both travel as an
// OutboxMessage without a job and with the full payload, in the envelope of
// transformMessageToMessageBroker ({ event_name, payload, ... }).

export const RUNTIME_EXCHANGE = 'workflow.exchange';
/** Product-owned topology; the Runtime may publish here, never bind or configure it. */
export const RUNTIME_RUN_RETRY_EXCHANGE = 'workflow.exchange.runtime_run_retry';
export const RUNTIME_RUN_QUEUE = 'workflow.jobs.runtime_run.queue';
export const RUNTIME_PUBLISH_QUEUE = 'workflow.jobs.runtime_publish.queue';
export const RUNTIME_RUN_ROUTING_KEY = `workflow.jobs.created.${WorkflowType.RUNTIME_RUN}`;
export const RUNTIME_PUBLISH_ROUTING_KEY = `workflow.jobs.created.${WorkflowType.RUNTIME_PUBLISH}`;
export const RUNTIME_RUN_BINDING = `workflow.jobs.*.${WorkflowType.RUNTIME_RUN}`;
/** Control commands (stop, revoke, approvals, pool): a queue of their own, so they never wait behind Run requests. */
export const RUNTIME_CONTROL_QUEUE = 'workflow.jobs.runtime_control.queue';
export const RUNTIME_CONTROL_ROUTING_KEY = `workflow.jobs.created.${WorkflowType.RUNTIME_CONTROL}`;
export const RUNTIME_CONTROL_BINDING = `workflow.jobs.*.${WorkflowType.RUNTIME_CONTROL}`;
export const RUNTIME_PUBLISH_BINDING = `workflow.jobs.*.${WorkflowType.RUNTIME_PUBLISH}`;
/** Pull request events the product worker decides on (PR 2): product to product, never to the Runtime. */
export const RUNTIME_TRIGGER_QUEUE = 'workflow.jobs.runtime_trigger.queue';
export const RUNTIME_TRIGGER_ROUTING_KEY = `workflow.jobs.created.${WorkflowType.RUNTIME_TRIGGER}`;
export const RUNTIME_TRIGGER_BINDING = `workflow.jobs.*.${WorkflowType.RUNTIME_TRIGGER}`;

export const RuntimeEventName = {
    RunRequested: 'runtime.run.requested',
    RunCancelRequested: 'runtime.run.cancel_requested',
    PublishRequested: 'runtime.publish.requested',
    PullRequestObserved: 'runtime.pull_request.observed',
} as const;

const id = z.string().min(1).max(128);
const sha = z.string().regex(/^[0-9a-f]{40}$/);

export { ExposeSchema };

/** A token the product sealed for this Run (sealed-secret.ts); a plain token is refused. */
const sealedToken = z
    .string()
    .min(1)
    .max(8_192)
    .refine((v): boolean => isSealedSecret(v), { message: 'the token must be sealed (sealed:v1:…), never plain' });

/** Path of the marker entry the product appends when it could not hand the whole diff. */
export { DIFF_TRUNCATED_MARKER_PATH };
/** What the whole diff of one Run may weigh, patches and contents together. */
export const MAX_DIFF_BYTES = 16 * 1024 * 1024;

/** Display metadata from the Git API's PR target ref; never a checkout selector. */
const MAX_RUN_BASE_BRANCH_CHARS = 1_024;
export const RunBaseBranchSchema = z
    .string()
    .min(1)
    .max(MAX_RUN_BASE_BRANCH_CHARS)
    .refine(
        (value) => {
            // Zod may still run refinements after a length issue: bound the scan independently.
            if (value.length > MAX_RUN_BASE_BRANCH_CHARS) return false;
            for (let index = 0; index < value.length; index += 1) {
                const code = value.charCodeAt(index);
                if (code <= 0x20 || code === 0x7f) return false;
            }
            return true;
        },
        {
            message:
                'PR target ref must not contain ASCII whitespace or control characters',
        },
    );

export const RuntimeRunRequestedSchema = z.strictObject({
    runId: z.uuid(),
    attempt: z.number().int().min(1),
    correlationId: z.string().min(1).max(128),
    requestedAt: z.iso.datetime(),
    organizationId: id,
    teamId: id,
    repository: z.strictObject({ id, name: z.string().min(1).max(256), fullName: z.string().max(512).optional() }),
    pullRequest: z.strictObject({
        number: z.number().int().min(1),
        headSha: sha,
        baseSha: sha,
        /** The target ref verified by the product; absent on older commands. */
        baseBranch: RunBaseBranchSchema.optional(),
        fork: z.boolean(),
        /**
         * Only for a fork: false when the environment's policy runs forks without
         * a maintainer (ADR-030). Absent means required: the worker's gate fails closed.
         */
        forkApprovalRequired: z.boolean().optional(),
        authorId: z.string().max(128).optional(),
        /** Untrusted text, read only by the intent classifier (§4). */
        title: z.string().max(1_024).optional(),
        description: z.string().max(65_536).optional(),
    }),
    environment: z.strictObject({
        environmentId: id,
        imageId: id,
        expose: z.array(ExposeSchema).max(32),
        /**
         * The recipe the environment setup recorded from the default branch,
         * added by the runtime-worker (never by the product): the cell boots
         * with it, not with the PR's copy (§6).
         */
        recipe: z
            .strictObject({
                path: z.string().min(1).max(256),
                content: z.string().max(65_536).nullable(),
                digest: z.string().max(128).optional(),
                /** The setup's authored files (never the product's, never the PR's): the worker sets them from its record. */
                files: AuthoredFilesSchema.optional(),
            })
            .optional(),
        /**
         * The machine size the environment's setup booted with, added by the
         * runtime-worker from the setup record (never by the product): the
         * Run boots base and PR at the same size. Absent: the cell's default.
         */
        size: MachineSizeSchema.optional(),
        /**
         * The setup's ready check, added by the runtime-worker from the setup
         * record (never by the product): after every machine.reset the Run
         * waits for it before a probe, because compose up does not wait for
         * the app to listen. Absent: a probe goes right after the reset.
         */
        ready: z
            .strictObject({
                service: z.string().min(1).max(128),
                port: z.number().int().min(1).max(65_535),
                path: z.string().startsWith('/').max(1_024),
                waitSeconds: z.number().int().min(0).max(900),
            })
            .optional(),
    }),
    /** Unified diff of the PR, read by the trigger from the Git API (ADR-057), never from the webhook. */
    diff: z
        .array(
            z.strictObject({
                path: z.string().min(1).max(1_024),
                patch: z.string().max(1_000_000),
                /** Content after the change; the entry-point extractor reads routes from it. */
                content: z.string().max(1_000_000).optional(),
            }),
        )
        .max(501)
        .refine((d) => d.reduce((n, f) => n + f.patch.length + (f.content?.length ?? 0), 0) <= MAX_DIFF_BYTES, {
            message: `the diff weighs more than ${MAX_DIFF_BYTES} characters`,
        }),
    /**
     * The product cut the diff (too many files or too many bytes): the Run is
     * partly tested at best, and the diff ends with the marker entry
     * DIFF_TRUNCATED_MARKER_PATH, which the entry-point extractor never settles.
     */
    diffTruncated: z.boolean().optional(),
    /**
     * Root `.kodus/` files the PR changes, read by the product from the whole
     * file list (renames included), so a cut diff still names them (S-19). The
     * worker keeps those whose PR copy the Run never boots (recipeFilesChangedBy:
     * the workspace files and the setup's authored files) as the recipe change;
     * the others are build files the PR side boots with.
     */
    prChangedRecipeFiles: z.array(z.string().regex(RECIPE_CHANGED_PATH)).max(MAX_RECIPE_CHANGED_PATHS).optional(),
    /** Download token for this repo only, 1 h, contents:read (ADR-002, ADR-052), sealed for this Run. Never enters the VM. */
    repoToken: sealedToken,
    /**
     * The PR side's own download token. Each claim revokes the token it fetched
     * with, so one shared token left the PR with a 401 whenever the base fetched
     * first (cell-dev-1, once memory admission ran the sides one after the
     * other). Absent (an older product): both sides use repoToken.
     */
    prRepoToken: sealedToken.optional(),
    /** Token of this Run for the product's LLM gateway (ADR-057), sealed for this Run. */
    runToken: sealedToken,
    budget: z.strictObject({ maxTokens: z.number().int().min(1).max(100_000_000) }).optional(),
    trigger: z.enum(RUN_TRIGGERS),
    externalVerification: ExternalVerificationSchema.optional(),
}).refine((req) => (req.trigger === 'external_finding') === !!req.externalVerification, { message: 'external verification metadata and trigger must be supplied together' });
export type RuntimeRunRequested = z.infer<typeof RuntimeRunRequestedSchema>;

/**
 * Whether a Run waits for a maintainer's approval of its head before it
 * boots (ADR-030): every fork, unless the product said its environment's
 * policy runs forks at once. Anything but an explicit false requires it.
 */
export const isForkApprovalRequired = (req: Pick<RuntimeRunRequested, 'pullRequest'>): boolean =>
    req.pullRequest.fork && req.pullRequest.forkApprovalRequired !== false;

export const RuntimeRunCancelRequestedSchema = z.strictObject({
    organizationId: id,
    repositoryId: id,
    prNumber: z.number().int().min(1),
    reason: z.enum(['pr_closed', 'superseded', 'stop']),
    /** For `superseded`: the new head; Runs of any other SHA are cancelled. */
    headSha: sha.optional(),
    correlationId: z.string().min(1).max(128).optional(),
});
export type RuntimeRunCancelRequested = z.infer<typeof RuntimeRunCancelRequestedSchema>;

/**
 * A pull request event as the webhook handler saw it (PR 2). It only says
 * what happened; the trigger reads the head, draft, labels, author, the diff
 * and the permissions from the Git API before it decides (ADR-057).
 * `headSha`, `draft`, `labels` and `author` are kept for old producers and
 * for logs only: no decision reads them.
 */
export const RuntimePullRequestObservedSchema = z.strictObject({
    organizationId: id,
    teamId: id,
    repository: z.strictObject({ id, name: z.string().min(1).max(256), fullName: z.string().max(512).optional() }),
    prNumber: z.number().int().min(1),
    event: z.enum(['opened', 'reopened', 'ready_for_review', 'synchronize', 'closed', 'comment']),
    headSha: sha.optional(),
    draft: z.boolean().optional(),
    labels: z.array(z.string().max(256)).max(100),
    author: z.strictObject({ login: z.string().max(256).optional(), isBot: z.boolean() }).optional(),
    /** For `comment`: who wrote `@kody runtime`; the trigger checks their permission on the repo. */
    commenter: z.strictObject({ id: z.string().max(128).optional(), login: z.string().max(256).optional() }).optional(),
    /** For `comment`: the platform's id of the `@kody runtime` comment, so the comment and its author can be read again from the Git API. */
    commentId: z.string().min(1).max(128).optional(),
    observedAt: z.iso.datetime(),
});
export type RuntimePullRequestObserved = z.infer<typeof RuntimePullRequestObservedSchema>;

/** The outbox row the webhook handler writes for a pull request event (product worker consumes it). */
export function runtimeTriggerOutboxMessage(payload: RuntimePullRequestObserved, messageId: string) {
    return runtimeOutboxMessage(RuntimeEventName.PullRequestObserved, payload, messageId);
}

export const PUBLISH_KINDS = ['check', 'comment'] as const;
export type PublishKind = (typeof PUBLISH_KINDS)[number];

/**
 * What the Runtime asks the product worker to publish (ADR-052). It carries
 * no target: org, repo, PR and SHA come from the Run's own record.
 */
export const RuntimePublishRequestedSchema = z.strictObject({
    runId: z.uuid(),
    attempt: z.number().int().min(1),
    kind: z.enum(PUBLISH_KINDS),
    /** Idempotency key `runId:attempt:kind`. */
    key: z.string().min(1).max(256),
    correlationId: z.string().min(1).max(128),
    check: z
        .strictObject({
            status: z.enum(['queued', 'in_progress', 'completed']),
            conclusion: z.enum(CHECK_CONCLUSIONS).optional(),
            title: z.string().min(1).max(256),
            summary: z.string().max(65_535),
        })
        .optional(),
    /** Legacy free text; the product renders `report` and `progress` itself (ADR-052). */
    comment: z.strictObject({ body: z.string().min(1).max(65_535) }).optional(),
    /** The final result, as structured fields: the comment, the replies and the check summary. */
    report: RuntimeRunReportSchema.optional(),
    /** The comment while the Run works, edited at each phase (key `runId:attempt:comment:<phase>`). */
    progress: RuntimeRunProgressSchema.optional(),
});
export type RuntimePublishRequested = z.infer<typeof RuntimePublishRequestedSchema>;

/** Phases of a check published before the final verdict, each under its own key (the final key stays `runId:attempt:check`). */
export const PUBLISH_PHASES = ['awaiting_approval'] as const;
export type PublishPhase = (typeof PUBLISH_PHASES)[number];

/** Idempotency key `runId:attempt:kind`, or `runId:attempt:<kind>:<phase>` for a check or comment published before the verdict. */
export const publishKey = (runId: string, attempt: number, kind: PublishKind, phase?: PublishPhase | CommentPhase) =>
    phase ? `${runId}:${attempt}:${kind}:${phase}` : `${runId}:${attempt}:${kind}`;

/** The broker envelope (same shape as IMessageBrokerService.transformMessageToMessageBroker). */
export interface RuntimeEnvelope<T> {
    event_name: string;
    payload: T;
    event_version: number;
    occurred_on: string | Date;
    messageId: string;
}

export function runtimeEnvelope<T>(eventName: string, payload: T, messageId: string, now = new Date()): RuntimeEnvelope<T> {
    return { event_name: eventName, payload, event_version: 1, occurred_on: now, messageId };
}

type RuntimeEventNameValue = (typeof RuntimeEventName)[keyof typeof RuntimeEventName];

/** The payload of each product → Runtime event, by its name. */
export interface RuntimeEventPayloads {
    'runtime.run.requested': RuntimeRunRequested;
    'runtime.run.cancel_requested': RuntimeRunCancelRequested;
    'runtime.publish.requested': RuntimePublishRequested;
    'runtime.pull_request.observed': RuntimePullRequestObserved;
}

const EVENT_ROUTES: Record<RuntimeEventNameValue, { schema: z.ZodType; routingKey: string; workflowType: WorkflowType }> = {
    [RuntimeEventName.RunRequested]: { schema: RuntimeRunRequestedSchema, routingKey: RUNTIME_RUN_ROUTING_KEY, workflowType: WorkflowType.RUNTIME_RUN },
    [RuntimeEventName.RunCancelRequested]: { schema: RuntimeRunCancelRequestedSchema, routingKey: RUNTIME_RUN_ROUTING_KEY, workflowType: WorkflowType.RUNTIME_RUN },
    [RuntimeEventName.PublishRequested]: { schema: RuntimePublishRequestedSchema, routingKey: RUNTIME_PUBLISH_ROUTING_KEY, workflowType: WorkflowType.RUNTIME_PUBLISH },
    [RuntimeEventName.PullRequestObserved]: { schema: RuntimePullRequestObservedSchema, routingKey: RUNTIME_TRIGGER_ROUTING_KEY, workflowType: WorkflowType.RUNTIME_TRIGGER },
};

/**
 * The outbox row of one event: no job, full payload (like SANDBOX_INVALIDATE).
 * The payload is validated against the event's own schema, so a cancel can
 * never travel under the name of a Run request.
 */
export function runtimeOutboxMessage<E extends RuntimeEventNameValue>(eventName: E, payload: RuntimeEventPayloads[E], messageId: string) {
    const route = EVENT_ROUTES[eventName];
    const parsed = route.schema.parse(payload) as Record<string, unknown>;
    return {
        jobId: undefined,
        exchange: RUNTIME_EXCHANGE,
        routingKey: route.routingKey,
        payload: runtimeEnvelope(eventName, { ...parsed, workflowType: route.workflowType }, messageId) as unknown as Record<string, unknown>,
    };
}

/**
 * @deprecated use runtimeOutboxMessage(eventName, payload, messageId). Kept
 * for callers outside libs/runtime; it now validates the pair too.
 */
export function runtimeRunOutboxMessage(payload: RuntimeRunRequested | RuntimeRunCancelRequested, eventName: string, messageId: string) {
    if (eventName !== RuntimeEventName.RunRequested && eventName !== RuntimeEventName.RunCancelRequested) {
        throw new Error(`runtimeRunOutboxMessage takes a Run request or a cancel, not ${eventName}`);
    }
    return runtimeOutboxMessage(eventName as 'runtime.run.requested', payload as RuntimeRunRequested, messageId);
}
