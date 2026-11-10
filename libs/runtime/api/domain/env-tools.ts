import type { EnvSessionOpen, EnvSessionOwner, EnvSessionView, EnvStepView, EnvValidationResolution } from '@libs/runtime/contracts/env-session';

// The API side of the /mcp/env tools (§4 "MCP e CLI", Inc. 1, S-27, S-46).

/** env_exec quota per team key and per org, in a sliding hour (S-27: a leaked key does not become free compute). */
export const ENV_EXEC_QUOTA = { perKeyPerHour: 120, perOrgPerHour: 600, windowMs: 3_600_000 } as const;
/** The command as the audit keeps it: redacted, then cut. */
export const ENV_AUDIT_MAX_COMMAND = 2_048;
export const ENV_AUDIT_KINDS = ['env_exec', 'env_fix'] as const;
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
    /** Redacted with the gitleaks rules before it is stored. */
    command: string;
    at: string;
    outcome: 'accepted' | 'refused_quota' | 'refused' | 'failed';
    reason?: string;
}

/** The env_exec / env_fix audit in the product Mongo; every read names the org. */
export interface RuntimeEnvAuditStore {
    record(r: EnvAuditRecord): Promise<void>;
    setOutcome(organizationId: string, auditId: string, outcome: EnvAuditRecord['outcome'], reason?: string): Promise<void>;
    /** Accepted env_exec records since `since`, of the org or only of one key. */
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
    exec(owner: EnvSessionOwner, sessionId: string, req: { stepId: string; command: string; cwd?: string; timeoutMs: number; validationName?: string; executionScope?: 'workload' }): Promise<EnvStepView>;
    step(owner: EnvSessionOwner, stepId: string): Promise<EnvStepView>;
    release(owner: EnvSessionOwner, sessionId: string): Promise<EnvSessionView>;
}

export const RUNTIME_ENV_SESSION_PORT = Symbol.for('RuntimeApi.EnvSessionPort');
export const RUNTIME_ENV_AUDIT_STORE = Symbol.for('RuntimeApi.EnvAuditStore');
