import { z } from 'zod';

import { MachineSizeSchema } from '@libs/runtime/contracts/machine-size';
import { SandboxOpCheckedSchema, type SandboxResult } from '@libs/runtime/protocol/sandbox';
import { MAX_TOOL_LAYERS, sandboxSnapshotError, SNAPSHOT_PURPOSES, SnapshotIdSchema, SnapshotKeySchema, ToolLayerPlanSchema } from '@libs/runtime/protocol/messages';

// The product's door to a code sandbox on a cell (docs/runtime/sandbox.md):
// the runtime-sandbox provider (libs/sandbox) calls the runtime-worker's
// listener (the env-session listener's port and signature, RUNTIME_ENV_SESSION_URL
// and RUNTIME_SECRET_SEAL_KEY), which calls the hub. A sandbox is named by its
// org and a sandboxId the provider picks; the hub's claim id derives from
// both, so any worker replica answers for any sandbox and no other org's id
// ever reaches one.

const Id = z.string().min(1).max(128);
const hostname = z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/);

export const SandboxRefSchema = z.strictObject({ organizationId: Id, sandboxId: z.uuid() });
export type SandboxRef = z.infer<typeof SandboxRefSchema>;

export const SandboxOpenSchema = z.strictObject({
    ...SandboxRefSchema.shape,
    // The hosts the caller fetches from (its git host); the org's approved hosts are added by the hub.
    egressAllow: z.array(hostname).max(16).optional(),
    size: MachineSizeSchema.optional(),
    // The org's secrets as placeholders in every exec's env (the injector adds
    // the value on each secret's hosts). Off unless asked: a review sandbox
    // holds the code of any PR, a fork's included, and a fork's code must not
    // reach the org's registry or API with the org's credential. A caller that
    // runs only the org's own code (a custom agent on its repository) asks.
    secrets: z.boolean().optional(),
    // Memory snapshots, on a cell that keeps them (docs/runtime/isolation-p3-snapshots.md).
    // templateKey: start from the org's newest template of the key when the cell
    // holds one (else the sandbox boots as usual). resumeFrom: a session, restored once.
    // prepares is not here: a template is made only through SANDBOX_ROUTES.template.
    templateKey: SnapshotKeySchema.optional(),
    resumeFrom: SnapshotIdSchema.optional(),
    // Tool layers (docs/runtime/persistent-state.md section 4): the CLI installs the caller plans, each by its id
    // (which becomes /opt/kcli/<id>). egressAllow still carries the registry hosts those installs need, as it always
    // did. The hub finds out per layer whether the cell it chose holds it (the view's toolLayers) and takes the
    // registry host of a held layer out of the sandbox's egress again; a layer that is not held is installed as before.
    toolLayers: z.array(ToolLayerPlanSchema).min(1).max(MAX_TOOL_LAYERS).optional(),
}).refine((b) => sandboxSnapshotError(b.secrets ? { ...b, secrets: ['asked'] } : { ...b, secrets: undefined }) === undefined, {
    message: 'resumeFrom goes with no templateKey',
    path: ['resumeFrom'],
}).refine((b) => new Set((b.toolLayers ?? []).map((l) => l.id)).size === (b.toolLayers ?? []).length, {
    message: 'a tool layer id is named once',
    path: ['toolLayers'],
});
export type SandboxOpen = z.infer<typeof SandboxOpenSchema>;

/**
 * A template of the org under templateKey: a fresh sandbox made as a
 * setup's (no secret), the steps run in it in order (each must succeed:
 * an exec exits 0, a file op is ok), then kept as the template, and the
 * sandbox released. The caller runs only what a setup runs (the default
 * branch, its tools), never a PR's code: the cell takes its word, as it does
 * a setup claim's. The newest template of a key replaces the others.
 */
export const SandboxTemplateSchema = z.strictObject({
    ...SandboxRefSchema.shape,
    templateKey: SnapshotKeySchema,
    egressAllow: z.array(hostname).max(16).optional(),
    size: MachineSizeSchema.optional(),
    steps: z.array(SandboxOpCheckedSchema).min(1).max(32),
});
export type SandboxTemplate = z.infer<typeof SandboxTemplateSchema>;

// pullRequest: the PR whose code a session holds (a review's sandbox). Its
// session goes when that PR closes or merges, not at SessionTTL (24 h).
export const SandboxSnapshotRequestSchema = z
    .strictObject({
        ...SandboxRefSchema.shape,
        stepId: z.uuid(),
        purpose: z.enum(SNAPSHOT_PURPOSES),
        pullRequest: z.strictObject({ repositoryId: Id, prNumber: z.number().int().min(1) }).optional(),
    })
    .refine((b) => !b.pullRequest || b.purpose === 'session', { message: 'only a session names its pull request', path: ['pullRequest'] });
export type SandboxSnapshotRequest = z.infer<typeof SandboxSnapshotRequestSchema>;

export interface SandboxSnapshotView {
    snapshotId: string;
    purpose: (typeof SNAPSHOT_PURPOSES)[number];
    ms: number;
}

export const SandboxOpRequestSchema = z.strictObject({ ...SandboxRefSchema.shape, stepId: z.uuid(), op: SandboxOpCheckedSchema });
export type SandboxOpRequest = z.infer<typeof SandboxOpRequestSchema>;

/** The claim id of a sandbox's claim on the hub is claimIdFor(organizationId, sandboxIdempotencyKey(sandboxId)). */
export const sandboxIdempotencyKey = (sandboxId: string) => `sandbox:${sandboxId}`;

export interface SandboxView {
    sandboxId: string;
    state: 'ready' | 'blocked';
    cellId?: string;
    leaseExpiresAt?: string;
    hardExpiresAt?: string;
    blockers?: { kind: string; signature: string; message: string }[];
    /**
     * One entry per planned tool layer when the cell keeps layers: hit means the layer is mounted
     * read-only at /opt/kcli/<id> and binaryPath and interpreter say where its CLI is and what runs it;
     * miss means the caller installs it as before (the sandbox's egress then allows the registry).
     * Absent: the cell keeps no layers, every plan is a miss.
     */
    toolLayers?: SandboxToolLayerView[];
}

export interface SandboxToolLayerView {
    id: string;
    state: 'hit' | 'miss';
    binaryPath?: string;
    interpreter?: string;
}

export type SandboxOpView = SandboxResult;

export const SANDBOX_ROUTES = {
    open: '/sandbox/open',
    op: '/sandbox/op',
    renew: '/sandbox/renew',
    release: '/sandbox/release',
    // Seals the sandbox's egress for good (the provider asks once its checkout is prepared).
    seal: '/sandbox/seal',
    snapshot: '/sandbox/snapshot',
    template: '/sandbox/template',
} as const;
