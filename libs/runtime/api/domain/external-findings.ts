import type { SubmitFindings } from '@libs/runtime/contracts/external-findings';
import type { RuntimeRunRequested } from '@libs/runtime/run/run-messages';
import type { EnvKeyPrincipal } from './env-tools';

export const RUNTIME_EXTERNAL_FINDINGS = Symbol.for(
    'RuntimeApi.ExternalFindings',
);
export const RUNTIME_EXTERNAL_FINDINGS_STORE = Symbol.for(
    'RuntimeApi.ExternalFindingsStore',
);
export const RUNTIME_EXTERNAL_STOP_READER = Symbol.for(
    'RuntimeApi.ExternalStopReader',
);
export const EXTERNAL_FINDINGS_QUOTA = {
    perKeyPerDay: 1000,
    perPullRequestPerDay: 1000,
    messagesPerKeyPerDay: 4000,
} as const;
export const EXTERNAL_MAINTENANCE_TICK_METRIC = 'runtime.a2a.maintenance.ticks';
export const EXTERNAL_MAINTENANCE_DURATION_METRIC =
    'runtime.a2a.maintenance.duration';
export const EXTERNAL_VERIFICATION_TTL_MS = 90 * 60_000;

export interface ExternalTaskView {
    id: string;
    contextId: string;
    state: 'completed' | 'working' | 'failed' | 'rejected';
    result: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface ExternalFindingsPort {
    submit(
        principal: EnvKeyPrincipal,
        input: unknown,
        messageId: string,
    ): Promise<ExternalTaskView>;
    verify(
        principal: EnvKeyPrincipal,
        input: unknown,
        messageId: string,
    ): Promise<ExternalTaskView>;
    getTask(
        principal: EnvKeyPrincipal,
        taskId: string,
    ): Promise<ExternalTaskView>;
}

export interface ExternalSubmissionRecord {
    receiptId: string;
    attempt: number;
    verificationTaskId: string;
    organizationId: string;
    teamId: string;
    keyId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
    fingerprint: string;
    findingIds: string[];
    submission: SubmitFindings;
    runId?: string;
    imageId?: string;
    refusal?:
        | 'execution_probe_required'
        | 'fork_approval_required'
        | 'runtime_stopped'
        | 'run_in_progress'
        | 'environment_not_ready';
    createdAt: string;
    expiresAt: string;
    terminal?: {
        state: 'completed' | 'failed';
        result: Record<string, unknown>;
        updatedAt: string;
    };
}

export interface ExternalSubmissionAdmission {
    record: ExternalSubmissionRecord;
    messageId: string;
    bodyHash: string;
    /** Admission time, separate from a deduplicated receipt's creation time. */
    at: string;
    /** Sealed, already validated Run input; only new admissions write it to outbox. */
    request?: RuntimeRunRequested;
    /** Existing receipt alias only: never recreate a retired receipt. */
    reuseOnly?: boolean;
}

export interface ExternalFindingsStore {
    quotaAvailable(
        organizationId: string,
        keyId: string,
        repositoryId: string,
        prNumber: number,
        at: string,
        amount: number,
    ): Promise<boolean>;
    byMessage(
        organizationId: string,
        keyId: string,
        messageId: string,
    ): Promise<{ record: ExternalSubmissionRecord; bodyHash: string } | null>;
    byFingerprint(
        organizationId: string,
        keyId: string,
        fingerprint: string,
    ): Promise<ExternalSubmissionRecord | null>;
    byTask(
        organizationId: string,
        taskId: string,
    ): Promise<ExternalSubmissionRecord | null>;
    byFinding(
        organizationId: string,
        findingId: string,
    ): Promise<ExternalSubmissionRecord | null>;
    complete(
        organizationId: string,
        taskId: string,
        terminal: NonNullable<ExternalSubmissionRecord['terminal']>,
    ): Promise<ExternalSubmissionRecord>;
    /** Only due task IDs, bounded and scoped; no global object enumeration. */
    listExpiredTaskIds(
        organizationId: string,
        at: string,
        limit: number,
    ): Promise<string[]>;
    /** Delete eligible old terminal payloads under the same org admission lock. */
    purgeTerminal(
        organizationId: string,
        cutoff: string,
        limit: number,
    ): Promise<number>;
    /** Product-side dedup, daily quota and receipt/task/outbox are one transaction. */
    admit(
        input: ExternalSubmissionAdmission,
    ): Promise<{ record: ExternalSubmissionRecord; deduplicated: boolean }>;
}

export interface ExternalStopReader {
    /** Unknown/unavailable state must throw, never mean 'running'. */
    isStopped(organizationId: string): Promise<boolean>;
}

export class ExternalAdmissionError extends Error {
    constructor(
        readonly code:
            | 'receipt_expired'
            | 'idempotency_conflict'
            | 'quota_exceeded'
            | 'message_quota_exceeded',
    ) {
        super(
            code === 'receipt_expired'
                ? 'External task retention window expired'
                : code !== 'idempotency_conflict'
                  ? 'External finding quota reached'
                  : 'Message id was already used with different content',
        );
    }
}

/** Stable JSON identity survives object-key normalization by JSONB and different transports. */
export function canonicalExternalJSON(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map(canonicalExternalJSON).join(',')}]`;
    if (value !== null && typeof value === 'object')
        return `{${Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonicalExternalJSON(v)}`)
            .join(',')}}`;
    return JSON.stringify(value);
}
