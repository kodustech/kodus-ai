import type { RecipeValidationCheck } from './recipe-validation';
import { RecipeValidationNameSchema } from './recipe-validation';
import { ENVIRONMENT_REPOSITORY_ROLES } from './enums';
import { MAX_WORKSPACE_REPOSITORIES, RepositoryAliasSchema, RepositoryFullNameSchema, workspaceShapeError } from './workspace';

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';

// The interactive environment of the dev's agent:
// the API's /mcp/env tools call the runtime-worker's env-session listener,
// which drives the claim through the hub like a Run does. Shared here so both
// sides parse the same bodies and sign requests the same way.

/** A session with no call for this long is released (the doc's mcp lease suspends after 10 min idle). */
export const ENV_SESSION_IDLE_MS = 10 * 60_000;
/** Live sessions of one org at a time (a quota of its own for MCP sessions). */
export const ENV_SESSION_MAX_LIVE_PER_ORG = 5;
/** Live sessions of one key at a time. */
export const ENV_SESSION_MAX_LIVE_PER_KEY = 2;
/** env_exec defaults and bounds; the hub refuses a step longer than 10 min. */
export const ENV_EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const ENV_EXEC_MAX_TIMEOUT_MS = 600_000;
export const ENV_EXEC_MAX_COMMAND = 8_192;
/** A step still running this long after its own timeout is reported lost (its worker went away). */
export const ENV_STEP_LOST_AFTER_MS = 60_000;
/** How long the open call waits for the claim before answering `acquiring`. */
export const ENV_SESSION_OPEN_WAIT_MS = 20_000;
/**
 * A signed request older or newer than this is refused. Inside it, each
 * request's nonce is accepted once (the listener remembers the nonces it saw
 * for this long), so a captured request cannot be sent again.
 */
export const ENV_SESSION_SIGNATURE_SKEW_MS = 15_000;

export const ENV_SESSION_STATES = ['acquiring', 'ready', 'blocked', 'released', 'expired', 'errored'] as const;
export type EnvSessionState = (typeof ENV_SESSION_STATES)[number];
export const isLiveEnvSession = (state: EnvSessionState) => state === 'acquiring' || state === 'ready';

const Id = z.string().min(1).max(128);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * Who is calling: the key and the repos it reaches right now (the list can
 * shrink between calls). The worker checks the row's org, team and key for
 * equality and its repo against the list, and answers 404 on any difference.
 */
export const EnvSessionOwnerSchema = z.strictObject({
    organizationId: Id,
    teamId: Id,
    keyId: Id,
    repositoryIds: z.array(Id).max(500),
});
export type EnvSessionOwner = z.infer<typeof EnvSessionOwnerSchema>;

/**
 * One repository of a multi-repository session: the commit it boots and a
 * download token for that repository only, sealed to
 * envSessionTokenBinding(sessionId). The primary repeats the session's own
 * repository, sha and token.
 */
export const EnvSessionWorkspaceRepositorySchema = z.strictObject({
    repositoryId: Id,
    fullName: RepositoryFullNameSchema,
    alias: RepositoryAliasSchema,
    role: z.enum(ENVIRONMENT_REPOSITORY_ROLES),
    sha: Sha,
    sealedRepoToken: z.string().min(1).max(8_192),
});
export type EnvSessionWorkspaceRepository = z.infer<typeof EnvSessionWorkspaceRepositorySchema>;

export const EnvSessionOpenSchema = z
    .strictObject({
        ...EnvSessionOwnerSchema.shape,
        repositoryId: Id,
        environmentId: Id,
        sessionId: z.uuid(),
        sha: Sha,
        repositoryFullName: z.string().min(1).max(256),
        /** Sealed to envSessionTokenBinding(sessionId); opened only inside the acquire. */
        sealedRepoToken: z.string().min(1).max(8_192),
        correlationId: Id,
        /** Every repository of a multi-repository environment, the primary included; absent for one repository. */
        workspace: z.array(EnvSessionWorkspaceRepositorySchema).min(2).max(MAX_WORKSPACE_REPOSITORIES).optional(),
    })
    .superRefine((m, ctx) => {
        const why = envSessionWorkspaceError(m);
        if (why) ctx.addIssue({ code: 'custom', path: ['workspace'], message: why });
    });
export type EnvSessionOpen = z.infer<typeof EnvSessionOpenSchema>;

/** Why a session's workspace disagrees with the rest of the open, or undefined: its primary is the session's repository at the session's commit and token. */
export function envSessionWorkspaceError(m: {
    repositoryId: string;
    sha: string;
    sealedRepoToken: string;
    workspace?: EnvSessionWorkspaceRepository[];
}): string | undefined {
    if (!m.workspace) return undefined;
    const shape = workspaceShapeError(m.workspace);
    if (shape) return shape;
    const primary = m.workspace.find((r) => r.role === 'primary')!;
    if (primary.repositoryId !== m.repositoryId) return "the workspace's primary is the session's repository";
    if (primary.sha !== m.sha || primary.sealedRepoToken !== m.sealedRepoToken) return "the workspace's primary boots the session's commit with the session's token";
    return undefined;
}

export const EnvSessionExecSchema = z.strictObject({
    ...EnvSessionOwnerSchema.shape,
    stepId: z.uuid(),
    command: z.string().min(1).max(ENV_EXEC_MAX_COMMAND),
    cwd: z.string().max(1_024).optional(),
    timeoutMs: z.number().int().min(1_000).max(ENV_EXEC_MAX_TIMEOUT_MS),
    validationName: RecipeValidationNameSchema.optional(),
    executionScope: z.literal('workload').optional(),
    /** The alias of the repository whose directory the command runs in (a multi-repository session); absent: the primary's. */
    repository: RepositoryAliasSchema.optional(),
});
export type EnvSessionExec = z.infer<typeof EnvSessionExecSchema>;

export const EnvSessionValidationSchema = z.strictObject({ ...EnvSessionOwnerSchema.shape, name: RecipeValidationNameSchema });
export interface EnvValidationResolution {
    session: EnvSessionView;
    name: RecipeValidationCheck['name'];
    command: RecipeValidationCheck['run'];
    recipeSha: string;
    recipeDigest: string;
}

export interface EnvSessionBlocker {
    kind: string;
    signature: string;
    message: string;
}

/** A session as the agent sees it; the claim id and the cell stay on the Runtime side. */
export interface EnvSessionView {
    sessionId: string;
    environmentId: string;
    repositoryId: string;
    sha: string;
    state: EnvSessionState;
    leaseExpiresAt?: string;
    services?: { name: string; health: 'ok' | 'failed' }[];
    /** A multi-repository session's layout: every repository under ws/<alias>, the primary first. Absent for one repository. */
    repositories?: EnvSessionRepositoryView[];
    blockers?: EnvSessionBlocker[];
    /** Why the session ended or failed, in words for the dev. */
    reason?: string;
    createdAt: string;
    lastUsedAt: string;
}

export interface EnvSessionRepositoryView {
    repositoryId: string;
    fullName: string;
    alias: string;
    role: (typeof ENVIRONMENT_REPOSITORY_ROLES)[number];
    sha: string;
}

export interface EnvStepView {
    stepId: string;
    sessionId: string;
    state: 'running' | 'done' | 'lost';
    command: string;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    truncated?: boolean;
    durationMs?: number;
    /** Values the cell replaced with [redacted:<rule>]. */
    redactions?: number;
    /** An environment error instead of a result (lease expired, cell out of reach). */
    error?: string;
}

/** What the session's repo download token is sealed to. */
export const envSessionTokenBinding = (sessionId: string) => `mcp:${sessionId}`;

/** The HMAC key of API → worker env-session calls, derived from the sealing key both already hold (one secret to manage). */
export const envSessionKeyFrom = (sealKey: Buffer) => createHmac('sha256', sealKey).update('kody-runtime/env-session/v1').digest();

export const ENV_SESSION_SIGNATURE_HEADER = 'x-kodus-env-signature';

/** The ownership rule both sides apply to a loaded session. */
export const ownsEnvSession = (row: { organizationId: string; teamId: string; keyId: string; repositoryId: string }, owner: EnvSessionOwner) =>
    row.organizationId === owner.organizationId && row.teamId === owner.teamId && row.keyId === owner.keyId && owner.repositoryIds.includes(row.repositoryId);

const mac = (key: Buffer, method: string, path: string, at: number, nonce: string, body: string) =>
    createHmac('sha256', key)
        .update(`${method.toUpperCase()}\n${path}\n${at}\n${nonce}\n${createHash('sha256').update(body).digest('hex')}`)
        .digest('hex');

/** A fresh nonce of one signed request: 16 random bytes, hex. */
export const envSessionNonce = () => randomBytes(16).toString('hex');

/** `t=<ms>,n=<nonce>,v1=<hex>` over method, path, time, the nonce and the body's hash. */
export function signEnvSessionRequest(key: Buffer, req: { method: string; path: string; body: string; at: number; nonce?: string }): string {
    const nonce = req.nonce ?? envSessionNonce();
    return `t=${req.at},n=${nonce},v1=${mac(key, req.method, req.path, req.at, nonce, req.body)}`;
}

/**
 * The time and nonce of a request whose signature holds and whose time is
 * inside the skew window; null otherwise. The caller still refuses a nonce it
 * already saw (EnvSessionNonces).
 */
export function verifiedEnvSessionRequest(key: Buffer, header: string | undefined, req: { method: string; path: string; body: string; now: number }): { at: number; nonce: string } | null {
    const m = /^t=(\d{1,16}),n=([0-9a-f]{32}),v1=([0-9a-f]{64})$/.exec(header ?? '');
    if (!m) return null;
    const at = Number(m[1]);
    if (!Number.isSafeInteger(at) || Math.abs(req.now - at) > ENV_SESSION_SIGNATURE_SKEW_MS) return null;
    const want = Buffer.from(mac(key, req.method, req.path, at, m[2], req.body), 'hex');
    const got = Buffer.from(m[3], 'hex');
    return want.length === got.length && timingSafeEqual(want, got) ? { at, nonce: m[2] } : null;
}

/** Whether the signature of a request holds inside the skew window (its nonce is not checked here). */
export function verifyEnvSessionRequest(key: Buffer, header: string | undefined, req: { method: string; path: string; body: string; now: number }): boolean {
    return verifiedEnvSessionRequest(key, header, req) !== null;
}

/**
 * The nonces a listener accepted, each kept until its request leaves the skew
 * window: a nonce seen again inside it is a replay. Bounded: past `max`
 * entries the oldest are dropped first.
 */
export class EnvSessionNonces {
    private readonly seen = new Map<string, number>();

    constructor(private readonly max = 50_000) {}

    /** True the first time a nonce is offered inside the window; false for a replay. */
    accept(nonce: string, at: number, now: number): boolean {
        for (const [n, expires] of this.seen) {
            if (expires > now) break;
            this.seen.delete(n);
        }
        const known = this.seen.get(nonce);
        if (known !== undefined && known > now) return false;
        this.seen.delete(nonce);
        while (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
        // Kept until the request could no longer pass the time check.
        this.seen.set(nonce, Math.max(at, now) + ENV_SESSION_SIGNATURE_SKEW_MS);
        return true;
    }

    get size(): number {
        return this.seen.size;
    }
}
