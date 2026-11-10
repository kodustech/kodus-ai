import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import type { MachineSize } from '@libs/runtime/contracts/machine-size';
import type { RuntimeRunRequested } from '@libs/runtime/run/run-messages';

export type AdmissionKind = 'run' | 'setup';
export interface AdmissionRef {
    organizationId: string;
    kind: AdmissionKind;
    key: string;
}
/** Physical identity stays stable while a short worker lease changes during repair. */
export interface AdmissionIdentity extends AdmissionRef {
    generation: number;
    ticketOwnerToken: string;
}
export interface AdmissionLease extends AdmissionIdentity {
    leaseToken: string;
    ownerEpoch: number;
    ownerUntil: string;
}

export type AdmissionPayload =
    | {
          kind: 'run';
          request: RuntimeRunRequested;
          options?: { forkApproved?: boolean; queuedAt?: string };
      }
    | { kind: 'setup'; request: RuntimeEnvironmentSetupRequested };

export type AdmissionState =
    | 'awaiting_approval'
    | 'waiting'
    | 'owned'
    | 'reserved'
    | 'dispatched'
    | 'running'
    | 'completed'
    | 'cancelled'
    | 'expired'
    | 'rejected';
export type AdmissionReason =
    | 'no_cell'
    | 'no_capacity'
    | 'org_capacity'
    | 'pair_too_large'
    | 'size_unavailable'
    | 'owner_changed'
    | 'ticket_expired'
    | 'global_limit'
    | 'org_limit'
    | 'setup_limit'
    | 'deadline'
    | 'attempt_limit'
    | 'cancelled'
    | 'completed'
    | 'unavailable'
    | 'member_cleanup_pending';

export interface PhysicalAdmissionRequest extends AdmissionIdentity {
    executionId: string;
    deadlineAt: string;
    members: Array<{ side: 'base' | 'pr' | 'setup'; idempotencyKey: string }>;
    size?: MachineSize;
}
export interface PhysicalAdmissionTicket extends AdmissionIdentity {
    ticketId: string;
    cellId: string;
    sessionEpoch: string;
    expiresAt: string;
    members: Array<{
        side: 'base' | 'pr' | 'setup';
        idempotencyKey: string;
        claimId: string;
    }>;
}
export type PhysicalAdmissionResult =
    | { status: 'reserved'; ticket: PhysicalAdmissionTicket }
    | { status: 'refused'; reason: AdmissionReason; retryable: boolean };

export interface AdmissionRecord extends AdmissionIdentity {
    payload: AdmissionPayload | null;
    payloadBytes: number;
    executionId: string | null;
    state: AdmissionState;
    /** Null only during fork approval or on a cancellation tombstone. Set once when admission starts. */
    deadlineAt: string | null;
    approvalDeadlineAt: string | null;
    nextAt: string | null;
    maxAttempts: number;
    leaseToken: string | null;
    ownerEpoch: number;
    ownerUntil: string | null;
    /** Remains counted after lease/ticket expiry and cancellation until explicit cleanup completion. */
    permitHeld: boolean;
    ticket: PhysicalAdmissionTicket | null;
    lastReason: AdmissionReason | null;
    createdAt: string;
    updatedAt: string;
}

export interface AdmissionLimits {
    globalWaiting: number;
    perOrgWaiting: number;
    globalExecuting: number;
    perOrgExecuting: number;
    maxAttempts: number;
    maxPayloadBytes?: number;
    globalBacklogBytes?: number;
    orgBacklogBytes?: number;
}
export const ADMISSION_WAIT_MS = 30 * 60_000;
export const ADMISSION_APPROVAL_MS = 7 * 24 * 60 * 60_000;
export const ADMISSION_BYTE_LIMITS = {
    maxPayloadBytes: 20 * 1024 * 1024,
    globalBacklogBytes: 256 * 1024 * 1024,
    orgBacklogBytes: 64 * 1024 * 1024,
} as const;

export type AdmissionAcceptResult =
    | { status: 'accepted' | 'existing'; record: AdmissionRecord }
    | { status: 'cancelled'; record: AdmissionRecord }
    | { status: 'conflict' | 'backlog_full' | 'payload_too_large' };
export type AdmissionTakeResult =
    | { status: 'taken'; lease: AdmissionLease; record: AdmissionRecord }
    | { status: 'busy' | 'stale' | 'cancelled' | 'expired' | 'missing' };
export type AdmissionReserveResult =
    | { status: 'reserved'; record: AdmissionRecord }
    | {
          status:
              | 'global_limit'
              | 'org_limit'
              | 'setup_limit'
              | 'stale'
              | 'expired';
      };
export interface AdmissionTransition {
    changed: boolean;
    record: AdmissionRecord | null;
    releasedTicket?: PhysicalAdmissionTicket;
}
export interface AdmissionDue extends AdmissionRef {
    generation: number;
    action: 'approval' | 'attempt' | 'dispatch' | 'finalize';
}

/** All writes are tenant scoped and fenced. No method performs hub or DBOS I/O inside its transaction. */
export interface AdmissionStore {
    accept(
        payload: AdmissionPayload,
        limits: AdmissionLimits,
    ): Promise<AdmissionAcceptResult>;
    get(ref: AdmissionRef): Promise<AdmissionRecord | null>;
    approveRun(
        ref: AdmissionRef,
        tokens?: { repoToken: string; prRepoToken?: string; runToken: string },
        limits?: AdmissionLimits,
    ): Promise<AdmissionTransition>;
    cancel(
        ref: AdmissionRef,
        reason?: AdmissionReason,
    ): Promise<AdmissionTransition>;
    take(
        ref: AdmissionRef,
        generation: number,
        leaseMs: number,
    ): Promise<AdmissionTakeResult>;
    defer(
        lease: AdmissionLease,
        reason: AdmissionReason,
        nextAt: string,
    ): Promise<AdmissionTransition>;
    reject(
        lease: AdmissionLease,
        reason: AdmissionReason,
    ): Promise<AdmissionTransition>;
    reserveExecution(
        lease: AdmissionLease,
        limits: AdmissionLimits,
    ): Promise<AdmissionReserveResult>;
    attachTicket(
        lease: AdmissionLease,
        ticket: PhysicalAdmissionTicket,
    ): Promise<AdmissionTransition>;
    markDispatched(lease: AdmissionLease): Promise<AdmissionTransition>;
    startExecution(
        identity: AdmissionIdentity,
        executionId: string,
    ): Promise<AdmissionTransition>;
    /** Call only after terminal execution/claim cleanup is confirmed; expiry alone never frees a permit. */
    finishExecution(
        identity: AdmissionIdentity,
        executionId: string,
    ): Promise<AdmissionTransition>;
    /** Acknowledge only after physical cancellation succeeds; failed cleanup remains discoverable. */
    acknowledgeTicketCleanup(
        identity: AdmissionIdentity,
        ticketId: string,
    ): Promise<AdmissionTransition>;
    owns(identity: AdmissionIdentity): Promise<boolean>;
    /** Internal bounded maintenance scan: only small references, never the request payload. */
    due(limit: number): Promise<AdmissionDue[]>;
}

/** Only closed categories may cross into cleanup logs; never remote text. */
export type AdmissionCleanupFailureReason = 'cell_unavailable' | 'hub_refused' | 'unexpected' | 'store_unavailable';
export type AdmissionCleanupResult =
    | { status: 'done' }
    | { status: 'pending'; reason: 'member_cleanup_pending' }
    | { status: 'failed'; reason: AdmissionCleanupFailureReason };
export type AdmissionFinishResult =
    | { finished: boolean; cleanupFailed: false; cleanupPending?: false }
    | { finished: false; cleanupFailed: false; cleanupPending: true }
    | { finished: boolean; cleanupFailed: true; reason: AdmissionCleanupFailureReason };

/** Worker-facing physical reservation port; implementations never open request credentials. */
export interface PhysicalAdmissionClient {
    reserve(
        request: PhysicalAdmissionRequest,
    ): Promise<PhysicalAdmissionResult>;
    redeem(ticket: PhysicalAdmissionTicket): Promise<boolean>;
    /** Resolves only when done; MemberCleanupPendingError keeps the permit until authoritative absence. */
    cancel(ticket: PhysicalAdmissionTicket): Promise<void>;
}
