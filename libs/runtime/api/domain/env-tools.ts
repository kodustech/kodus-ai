import type { EnvSessionOpen, EnvSessionOwner, EnvSessionUpload, EnvSessionView, EnvStepView, EnvUploadView, EnvValidationResolution } from '@libs/runtime/contracts/env-session';

// The API side of the /mcp/env tools (§4 "MCP e CLI", Inc. 1, S-27, S-46).

/** env_exec quota per team key and per org, in a sliding hour (S-27: a leaked key does not become free compute); env_upload counts against it. */
export const ENV_EXEC_QUOTA = { perKeyPerHour: 120, perOrgPerHour: 600, windowMs: 3_600_000 } as const;
/** The command as the audit keeps it: redacted, then cut. */
export const ENV_AUDIT_MAX_COMMAND = 2_048;
export const ENV_AUDIT_KINDS = ['env_exec', 'env_fix', 'env_upload'] as const;
/** The kinds the env_exec quota counts: each sends work to a cell. */
export const ENV_QUOTA_KINDS = ['env_exec', 'env_upload'] as const;
export type EnvAuditKind = (typeof ENV_AUDIT_KINDS)[number];

/** A team key as the env tools see it, resolved from the request credential (never from tool arguments). */
export interface EnvKeyPrincipal {
    keyId: string;
    organizationId: string;
    teamId: string;
    capabilities: readonly string[];
    repositoryIds: readonly string[];
}

export interface EnvAuditRecord {
    auditId: string;
    kind: EnvAuditKind;
    organizationId: string;
    teamId: string;
    keyId: string;
    repositoryId: string;
    environmentId?: string;
    sessionId?: string;
    stepId?: string;
    /** Redacted with the gitleaks rules before it is stored; an upload's is its paths and sizes. */
    command: string;
    at: string;
    outcome: 'accepted' | 'refused_quota' | 'refused' | 'failed';
    reason?: string;
}

/** The env_exec / env_fix audit in the product Postgres; every read names the org. */
export interface RuntimeEnvAuditStore {
    record(r: EnvAuditRecord): Promise<void>;
    setOutcome(organizationId: string, auditId: string, outcome: EnvAuditRecord['outcome'], reason?: string): Promise<void>;
    /** Accepted env_exec and env_upload records (ENV_QUOTA_KINDS) since `since`, of the org or only of one key. */
    countAccepted(q: { organizationId: string; keyId?: string; since: string }): Promise<number>;
    list(q: { organizationId: string; kind: EnvAuditKind; limit: number; before?: string }): Promise<EnvAuditRecord[]>;
}

/** What the runtime-worker's env-session listener answered when it refused (status as HTTP). */
export class EnvSessionPortError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}

/** The runtime-worker's env-session listener (apps/runtime/src/worker/env-session). */
export interface RuntimeEnvSessionPort {
    open(req: EnvSessionOpen): Promise<EnvSessionView>;
    status(owner: EnvSessionOwner, sessionId: string): Promise<EnvSessionView>;
    validation(owner: EnvSessionOwner, sessionId: string, name: string): Promise<EnvValidationResolution>;
    exec(owner: EnvSessionOwner, sessionId: string, req: { stepId: string; command: string; cwd?: string; repository?: string; timeoutMs: number; validationName?: string; executionScope?: 'workload' }): Promise<EnvStepView>;
    step(owner: EnvSessionOwner, stepId: string): Promise<EnvStepView>;
    release(owner: EnvSessionOwner, sessionId: string): Promise<EnvSessionView>;
    upload(owner: EnvSessionOwner, sessionId: string, req: Pick<EnvSessionUpload, 'stepId' | 'files'>): Promise<EnvUploadView>;
}

export const RUNTIME_ENV_SESSION_PORT = Symbol.for('RuntimeApi.EnvSessionPort');
export const RUNTIME_ENV_AUDIT_STORE = Symbol.for('RuntimeApi.EnvAuditStore');

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The commits env_up boots, by repository alias: `sha` names the primary's (as
 * it always has), `commits` names any repository's by its alias. Every other
 * repository boots at its default-branch head. An unknown alias, a short sha,
 * or two different commits for the primary is the caller's mistake.
 */
export function envUpCommits(
    input: { sha?: unknown; commits?: unknown },
    aliases: readonly string[],
    primaryAlias: string,
): { commits: Map<string, string> } | { error: string } {
    const commits = new Map<string, string>();
    if (input.sha !== undefined && input.sha !== null && input.sha !== '') {
        if (typeof input.sha !== 'string' || !FULL_SHA.test(input.sha)) return { error: 'sha must be a full 40-character commit SHA' };
        commits.set(primaryAlias, input.sha);
    }
    if (input.commits === undefined || input.commits === null) return { commits };
    if (typeof input.commits !== 'object' || Array.isArray(input.commits)) {
        return { error: 'commits maps a repository alias to a full 40-character commit SHA' };
    }
    for (const [alias, sha] of Object.entries(input.commits as Record<string, unknown>)) {
        if (!aliases.includes(alias)) return { error: `commits names ${alias.slice(0, 64)}, which is not a repository of this environment: ${aliases.join(', ')}` };
        if (typeof sha !== 'string' || !FULL_SHA.test(sha)) return { error: `the commit of ${alias} must be a full 40-character commit SHA` };
        if (commits.has(alias) && commits.get(alias) !== sha) return { error: `sha and commits name two different commits for ${alias}` };
        commits.set(alias, sha);
    }
    return { commits };
}
