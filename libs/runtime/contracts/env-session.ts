import type { RecipeValidationCheck } from './recipe-validation';
import { RecipeValidationNameSchema } from './recipe-validation';

import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

// The interactive environment of the dev's agent (§4 "MCP e CLI", Inc. 1):
// the API's /mcp/env tools call the runtime-worker's env-session listener,
// which drives the claim through the hub like a Run does. Shared here so both
// sides parse the same bodies and sign requests the same way.

/** A session with no call for this long is released (the doc's mcp lease suspends after 10 min idle). */
export const ENV_SESSION_IDLE_MS = 10 * 60_000;
/** Live sessions of one org at a time (S-13: a quota of its own for MCP sessions). */
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
/** A signed request older or newer than this is refused (replay window). */
export const ENV_SESSION_SIGNATURE_SKEW_MS = 60_000;

export const ENV_SESSION_STATES = ['acquiring', 'ready', 'blocked', 'released', 'expired', 'errored'] as const;
export type EnvSessionState = (typeof ENV_SESSION_STATES)[number];
export const isLiveEnvSession = (state: EnvSessionState) => state === 'acquiring' || state === 'ready';

const Id = z.string().min(1).max(128);
const Sha = z.string().regex(/^[0-9a-f]{40}$/);

/**
 * Who is calling: the key and the repos it reaches right now (the list can
 * shrink between calls). The worker checks the row's org, team and key for
 * equality and its repo against the list, and answers 404 on any difference (S-46).
 */
export const EnvSessionOwnerSchema = z.strictObject({
    organizationId: Id,
    teamId: Id,
    keyId: Id,
    repositoryIds: z.array(Id).max(500),
});
export type EnvSessionOwner = z.infer<typeof EnvSessionOwnerSchema>;

export const EnvSessionOpenSchema = z.strictObject({
    ...EnvSessionOwnerSchema.shape,
    repositoryId: Id,
    environmentId: Id,
    sessionId: z.uuid(),
    sha: Sha,
    repositoryFullName: z.string().min(1).max(256),
    /** Sealed to envSessionTokenBinding(sessionId); opened only inside the acquire. */
    sealedRepoToken: z.string().min(1).max(8_192),
    correlationId: Id,
});
export type EnvSessionOpen = z.infer<typeof EnvSessionOpenSchema>;

export const EnvSessionExecSchema = z.strictObject({
    ...EnvSessionOwnerSchema.shape,
    stepId: z.uuid(),
    command: z.string().min(1).max(ENV_EXEC_MAX_COMMAND),
    cwd: z.string().max(1_024).optional(),
    timeoutMs: z.number().int().min(1_000).max(ENV_EXEC_MAX_TIMEOUT_MS),
    validationName: RecipeValidationNameSchema.optional(),
    executionScope: z.literal('workload').optional(),
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
    blockers?: EnvSessionBlocker[];
    /** Why the session ended or failed, in words for the dev. */
    reason?: string;
    createdAt: string;
    lastUsedAt: string;
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
    /** Values the cell replaced with [redacted:<rule>] (S-51). */
    redactions?: number;
    /** An environment error instead of a result (lease expired, cell out of reach). */
    error?: string;
}

/** What the session's repo download token is sealed to. */
export const envSessionTokenBinding = (sessionId: string) => `mcp:${sessionId}`;

/** The HMAC key of API → worker env-session calls, derived from the sealing key both already hold (one secret to manage). */
export const envSessionKeyFrom = (sealKey: Buffer) => createHmac('sha256', sealKey).update('kody-runtime/env-session/v1').digest();

export const ENV_SESSION_SIGNATURE_HEADER = 'x-kodus-env-signature';

/** The ownership rule both sides apply to a loaded session (S-46). */
export const ownsEnvSession = (row: { organizationId: string; teamId: string; keyId: string; repositoryId: string }, owner: EnvSessionOwner) =>
    row.organizationId === owner.organizationId && row.teamId === owner.teamId && row.keyId === owner.keyId && owner.repositoryIds.includes(row.repositoryId);

const mac = (key: Buffer, method: string, path: string, at: number, body: string) =>
    createHmac('sha256', key)
        .update(`${method.toUpperCase()}\n${path}\n${at}\n${createHash('sha256').update(body).digest('hex')}`)
        .digest('hex');

/** `t=<ms>,v1=<hex>` over method, path, time and the body's hash. */
export function signEnvSessionRequest(key: Buffer, req: { method: string; path: string; body: string; at: number }): string {
    return `t=${req.at},v1=${mac(key, req.method, req.path, req.at, req.body)}`;
}

export function verifyEnvSessionRequest(key: Buffer, header: string | undefined, req: { method: string; path: string; body: string; now: number }): boolean {
    const m = /^t=(\d{1,16}),v1=([0-9a-f]{64})$/.exec(header ?? '');
    if (!m) return false;
    const at = Number(m[1]);
    if (!Number.isSafeInteger(at) || Math.abs(req.now - at) > ENV_SESSION_SIGNATURE_SKEW_MS) return false;
    const want = Buffer.from(mac(key, req.method, req.path, at, req.body), 'hex');
    const got = Buffer.from(m[2], 'hex');
    return want.length === got.length && timingSafeEqual(want, got);
}
