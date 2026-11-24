import type { DesiredHostState } from './pr-decision-reducer';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

/**
 * The driver the applier writes through. Each method maps to one of the
 * ranked host calls; each method MUST be idempotent.
 *
 * The reconciler wires this up against the existing
 * `codeManagementService` + `ownChangeRequest` adapters in production.
 * Tests inject a mock driver.
 */
export interface HostDriver {
    /**
     * Requests dismissal of Kody's prior REQUEST_CHANGES review event on the
     * PR. Idempotent: if no active request exists, the call is a no-op.
     */
    dismissIfNeeded(
        hostRecord: HostRecord,
        host: HostContext,
    ): Promise<HostCallResult>;
    /**
     * Submits the host's APPROVE review event. Posts the host review state.
     */
    approve(hostRecord: HostRecord, host: HostContext): Promise<HostCallResult>;
    /**
     * Idempotent upsert of the conditional approval comment. Reads the
     * host's existing decision comment, updates if body changed, creates
     * otherwise.
     */
    upsertDecisionComment(
        hostRecord: HostRecord,
        comment: { kind: 'approve' | 'hold'; reason: string },
        host: HostContext,
    ): Promise<HostCallResult>;
}

export interface HostRecord {
    repoId: string;
    prNumber: number;
    headSha: string;
}

/**
 * The organisation and the repository the provider calls need. Carried on
 * every call so the driver stays stateless: the reconciler may run for
 * several PRs concurrently in one worker process.
 */
export interface HostContext {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
}

export type HostCallResult =
    | { status: 'ok' }
    | { status: 'retry'; reason: string }
    | { status: 'fatal'; reason: string };

/**
 * The per-PR record shape the applier reads/writes. `currentHostPR` and
 * `currentReviewEvent` reflect the host state read by the reconciler
 * before applying. `priorChangeRequestActive` is whether the user (or a
 * previous reconcile) left a Kody REQUEST_CHANGES event still open on the
 * host; that triggers the dismiss step.
 */
export interface PrRecordInput {
    repoId: string;
    prNumber: number;
    headSha: string;
    /** Snapshot key used to scope the applier's writes. */
    snapshotKey: string;
    /** Whether the host currently shows an active Kody REQUEST_CHANGES. */
    priorChangeRequestActive: boolean;
    /**
     * The organisation and the repository the provider calls need. The
     * `HostRecord` carries only ids, and the reconciler may run for several
     * PRs concurrently in one worker process, so the context travels with
     * the record rather than living in the driver.
     */
    host: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
    };
}

export type ApplyOutcomeKind = 'applied' | 'partial' | 'skipped-nochange';

export interface ApplyOutcome {
    kind: ApplyOutcomeKind;
    /** Per-step result, in the order they were attempted. */
    steps: Array<{
        step: 'dismiss' | 'approve' | 'upsertComment';
        result: HostCallResult;
    }>;
    /** The comment body that was (or would have been) written. */
    comment?: { kind: 'approve' | 'hold'; reason: string };
}

/**
 * Apply the desired host state to the host via the driver.
 *
 * Sequence (per spec Requirement "Idempotent host projection under one
 * ordered write"):
 *   1. `dismissIfNeeded`           (only if `priorChangeRequestActive` AND APPROVE)
 *   2. `approve`                   (only if desired.kind === 'APPROVE')
 *   3. `upsertDecisionComment`     (always, regardless of kind)
 *
 * Failure model: any step returning `retry` halts the sequence. The
 * reconciler reschedules with the refusal map; no rollback. `fatal` is
 * reserved for irrecoverable provider errors that the user should see.
 *
 * Idempotency: every host call is idempotent, so retrying the entire
 * sequence produces the same host outcome as the first attempt would have,
 * modulo the partial state already visible.
 */
export async function applyDesiredHostState(
    desired: DesiredHostState,
    record: PrRecordInput,
    driver: HostDriver,
): Promise<ApplyOutcome> {
    const hostRecord: HostRecord = {
        repoId: record.repoId,
        prNumber: record.prNumber,
        headSha: record.headSha,
    };

    const host: HostContext = record.host;

    const steps: ApplyOutcome['steps'] = [];

    // Step 1: dismiss prior change request if any, only on APPROVE path.
    if (desired.kind === 'APPROVE' && record.priorChangeRequestActive) {
        const result = await driver.dismissIfNeeded(hostRecord, host);
        steps.push({ step: 'dismiss', result });
        if (result.status !== 'ok') {
            return { kind: 'partial', steps };
        }
    }

    // Step 2: approve. Only for APPROVE.
    if (desired.kind === 'APPROVE') {
        const result = await driver.approve(hostRecord, host);
        steps.push({ step: 'approve', result });
        if (result.status !== 'ok') {
            return { kind: 'partial', steps, comment: composeComment(desired) };
        }
    }

    // Step 3: upsert decision comment. Always.
    const comment = composeComment(desired);
    const result = await driver.upsertDecisionComment(
        hostRecord,
        comment,
        host,
    );
    steps.push({ step: 'upsertComment', result });
    if (result.status !== 'ok') {
        return { kind: 'partial', steps, comment };
    }

    return {
        kind: 'applied',
        steps,
        comment,
    };
}

function composeComment(desired: DesiredHostState): {
    kind: 'approve' | 'hold';
    reason: string;
} {
    if (desired.kind === 'APPROVE') {
        return {
            kind: 'approve',
            reason: `Policy '${desired.policyId}' matched.`,
        };
    }
    return {
        kind: 'hold',
        reason: desired.reason,
    };
}

/** Build a driver from existing code-management + change-request adapters. */
export function makeCodeManagementHostDriver(): Pick<
    HostDriver,
    'dismissIfNeeded' | 'approve' | 'upsertDecisionComment'
> {
    // Stub for production wiring; the reconciler wires the real adapter.
    throw new Error(
        'makeCodeManagementHostDriver: wire to codeManagementService.approvePullRequest + postConditionalApprovalReason + ownChangeRequest.withdrawIfResolved',
    );
}
