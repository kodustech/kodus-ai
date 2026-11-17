import type { PublishKind, RuntimePublishRequested } from '@libs/runtime/run';

// What the product worker published for a Run (ADR-052). One row per
// idempotency key `runId:attempt:kind`, in the product's Postgres
// (`runtime_publications`). The Runtime never reads or writes it.

/** How long a claim holds before another delivery may take it over. */
export const PUBLICATION_LEASE_MS = 5 * 60 * 1000;

export type CheckWireStatus = 'queued' | 'in_progress' | 'completed';

/** Order of a check's lifecycle: a later status of the same key moves the same check run forward. */
export const CHECK_STATUS_RANK: Record<CheckWireStatus, number> = {
    queued: 1,
    in_progress: 2,
    completed: 3,
};

/**
 * `reply` = the answer on a review suggestion, under `runId:attempt:reply:<suggestionId>`.
 * `skip_reply` = the line on a PR whose `@kody runtime` started no Run, under
 * `trigger-skip:<org>:<repo>:<pr>:<head>:<reason>` (no Run: `runId` is the key, `attempt` 0).
 */
export type PublicationKind = PublishKind | 'reply' | 'skip_reply';

export type PublicationStatus =
    'publishing' | 'published' | 'skipped' | 'failed';

/** Ids of a PR comment, as the platform returned them (GitLab note, Azure thread). */
export interface PublishedCommentRef {
    id: string | number;
    noteId?: string | number;
    threadId?: string | number;
}

/** The org, team, repo, PR and head a publication belongs to, from the product's run target. */
export interface PublicationScope {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
}

export interface RuntimePublication extends PublicationScope {
    key: string;
    runId: string;
    attempt: number;
    kind: PublicationKind;
    status: PublicationStatus;
    leaseUntil?: string;
    /** For `check`: the last status published under this key. */
    checkRank?: number;
    checkRunId?: string | number;
    /** For `check`: deliveries whose create answered no check run (or no commit status); a few are retried, then the check is skipped. */
    checkCreateFailures?: number;
    /** For `check`: posted as a commit status, because the connection cannot create check runs (a GitHub personal access token). */
    commitStatus?: boolean;
    /** For `comment`: the PR comment this publication created or edited. */
    comment?: PublishedCommentRef;
    reason?: string;
    /** For a final comment: what was posted is the short notice of renderUndeliveredReportComment, not the report. */
    fallback?: boolean;
    /**
     * For a final publication (completed check, report comment): the validated
     * request, so the product can publish it again when the broker's retry is
     * lost (see publication-redrive.ts). Bounded by storableRequestOf.
     */
    request?: RuntimePublishRequested;
    /** What the redrive sweeper did with this row. */
    redrive?: PublicationRedrive;
    createdAt: string;
    updatedAt: string;
}

export interface PublicationRedrive {
    /** Deliveries the sweeper started for this row (the last one may be the fallback). */
    attempts: number;
    lastAt?: string;
    /** Set when the sweeper stopped trying: the row stays failed. */
    gaveUpAt?: string;
    /** Why it gave up: a code (attempts, refused:<reason>, unrecoverable), never a platform message. */
    gaveUpReason?: string;
}

export type ClaimResult =
    | { state: 'claimed'; publication: RuntimePublication }
    /** Already published (or skipped) for this key and status: nothing to do. */
    | { state: 'duplicate'; publication: RuntimePublication }
    /** Another delivery holds a live claim: retry later. */
    | { state: 'busy'; publication: RuntimePublication };

export interface ClaimRequest extends PublicationScope {
    key: string;
    runId: string;
    attempt: number;
    kind: PublicationKind;
    /** For `check`: rank of the status being published. */
    checkRank?: number;
    /** For a final publication: the request to keep for a redrive (see RuntimePublication.request). */
    request?: RuntimePublishRequested;
}

export type PublicationResult = Pick<RuntimePublication, 'status'> &
    Partial<
        Pick<
            RuntimePublication,
            'checkRank' | 'checkRunId' | 'commitStatus' | 'comment' | 'reason' | 'fallback'
        >
    >;

/** What a failed delivery keeps for the retry: ids obtained before the failure, and the create-failure count. */
export type PublicationRetryState = Partial<
    Pick<RuntimePublication, 'checkRunId' | 'checkCreateFailures'>
>;

/**
 * One row per idempotency key. The PR comment itself is owned by the
 * PullRequestCommentSlotStore: keys alone cannot serialize the phases of a
 * PR, the slot does.
 */
export interface PublicationStore {
    claim(request: ClaimRequest, now?: Date): Promise<ClaimResult>;
    complete(key: string, result: PublicationResult): Promise<void>;
    /** Drops the claim after a failed publish; `keep` survives for the retry. */
    release(
        key: string,
        reason: string,
        keep?: PublicationRetryState,
    ): Promise<void>;
    /** The check run recorded under `key` (a pre-verdict phase of the same Run), or null. */
    findCheckRunId(key: string): Promise<string | number | null>;
}

/** Read side for the dashboard: what the product published for one Run. */
export interface PublicationReader {
    /** Every publication of `runId` in `organizationId` (the filter is in the query), without the stored request. */
    listForRun(
        organizationId: string,
        runId: string,
    ): Promise<RuntimePublication[]>;
}

export const RUNTIME_PUBLICATION_READER_TOKEN = Symbol.for(
    'RuntimePublicationReader',
);

/** The sweeper's side: find final publications the broker lost, and take one at a time. */
export interface PublicationRedriveStore {
    /**
     * Final publications with a stored request, failed or with an expired
     * lease, untouched since `staleBefore` and not given up. Oldest first.
     */
    findStale(staleBefore: string, now: string, limit: number): Promise<RuntimePublication[]>;
    /**
     * Counts one redrive attempt, only if the row is still the one the sweeper
     * read (same `updatedAt`): two replicas never drive the same row at once.
     */
    reserveRedrive(
        key: string,
        seenUpdatedAt: string,
        now: string,
    ): Promise<RuntimePublication | null>;
    /** Stops redriving the row; it stays failed. */
    giveUp(key: string, reason: string, now: string): Promise<void>;
}

/** Whether a stored publication may be taken over by a new delivery. */
export function canClaim(
    existing: RuntimePublication,
    request: ClaimRequest,
    now: Date,
): boolean {
    // `checkRank` is the last status actually published, so a status at or
    // below it is a redelivery, whatever state the row is in.
    const advancesCheck =
        request.kind !== 'check' ||
        (request.checkRank ?? 0) > (existing.checkRank ?? 0);
    switch (existing.status) {
        case 'failed':
            return advancesCheck;
        case 'publishing':
            return isLeaseExpired(existing, now) && advancesCheck;
        case 'published':
            return request.kind === 'check' && advancesCheck;
        case 'skipped':
            return false;
    }
}

export function isLeaseExpired(
    existing: RuntimePublication,
    now: Date,
): boolean {
    return (
        !existing.leaseUntil || Date.parse(existing.leaseUntil) <= now.getTime()
    );
}

/** Why a claim was refused: a live claim of another delivery, or work already done. */
export function refusalState(
    existing: RuntimePublication,
    now: Date,
): 'busy' | 'duplicate' {
    return existing.status === 'publishing' && !isLeaseExpired(existing, now)
        ? 'busy'
        : 'duplicate';
}

/** The rule of PublicationRedriveStore.findStale, for the in-memory store and the tests. */
export function isStaleForRedrive(
    row: RuntimePublication,
    staleBefore: string,
    now: string,
): boolean {
    if (!row.request || row.redrive?.gaveUpAt || row.updatedAt > staleBefore) {
        return false;
    }
    return (
        row.status === 'failed' ||
        (row.status === 'publishing' && !!row.leaseUntil && row.leaseUntil <= now)
    );
}
