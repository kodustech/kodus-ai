import {
    COMMENT_PHASES,
    isTerminal,
    publishKey,
    type CommentPhase,
    type PublishPhase,
    type RunState,
} from '@libs/runtime/run';

import { CHECK_STATUS_RANK, type RuntimePublication } from './runtime-publication';

// What the product actually published for a Run, read from its own
// publication rows (`runtime_publications`), for the Run page. The Runtime's
// projection only knows that it asked to publish; whether the check and the
// comment reached the PR is known here alone.

/**
 * - published: on the PR (for a comment, maybe the short fallback notice);
 * - skipped: not posted on purpose (no checks API, a newer Run owns the comment);
 * - failed: the product gave up; the PR does not show it;
 * - pending: not on the PR yet (being published, or a failed delivery Kodus retries);
 * - not_expected: this Run does not publish it (a simulation, a fork waiting, a superseded Run's comment).
 */
export type PublicationViewStatus =
    | 'published'
    | 'skipped'
    | 'failed'
    | 'pending'
    | 'not_expected';

/** Skip reasons a reader may see; anything else (and every failure message) stays in the row. */
const SHOWN_SKIP_REASONS = ['checks_unavailable', 'stale_comment'] as const;
export type ShownSkipReason = (typeof SHOWN_SKIP_REASONS)[number];

export interface PublicationKindView {
    status: PublicationViewStatus;
    /** When the row last moved. */
    at?: string;
    reason?: ShownSkipReason;
    /** pending: the last delivery failed and is retried (by the broker or the redrive sweeper). */
    retrying?: boolean;
    /** Deliveries the redrive sweeper started for it. */
    redriveAttempts?: number;
    /** published comment: only the short notice went out; the report is in Kodus. */
    fallback?: boolean;
    /** comment not final yet: the last progress phase the PR comment shows. */
    showing?: CommentPhase;
}

export interface RunPublicationView {
    /** False when the product stored no publish target (a simulation): nothing is ever posted. */
    postsToPullRequest: boolean;
    check: PublicationKindView;
    comment: PublicationKindView;
    /** Nothing about the PR will change any more. */
    settled: boolean;
}

export interface RunPublicationInput {
    runId: string;
    attempt: number;
    state: RunState;
    postsToPullRequest: boolean;
    rows: RuntimePublication[];
}

const NOT_EXPECTED: PublicationKindView = { status: 'not_expected' };
const FINAL: ReadonlySet<PublicationViewStatus> = new Set([
    'published',
    'skipped',
    'failed',
    'not_expected',
]);

export function runPublicationViewOf(
    input: RunPublicationInput,
): RunPublicationView {
    if (!input.postsToPullRequest) {
        return {
            postsToPullRequest: false,
            check: NOT_EXPECTED,
            comment: NOT_EXPECTED,
            settled: true,
        };
    }
    const rows = new Map(
        input.rows
            .filter((r) => r.attempt === input.attempt)
            .map((r) => [r.key, r]),
    );
    const key = (kind: 'check' | 'comment', phase?: CommentPhase | PublishPhase) =>
        publishKey(input.runId, input.attempt, kind, phase);

    const check = checkViewOf(
        rows.get(key('check')) ?? rows.get(key('check', 'awaiting_approval')),
    );
    const comment = commentExpected(input.state)
        ? commentViewOf(
              rows.get(key('comment')),
              lastShownPhase((phase) => rows.get(key('comment', phase))),
          )
        : NOT_EXPECTED;
    return {
        postsToPullRequest: true,
        check,
        comment,
        settled:
            isTerminal(input.state) &&
            FINAL.has(check.status) &&
            FINAL.has(comment.status),
    };
}

/** A fork waiting for a maintainer shows the check only; a superseded or cancelled Run closes the check without a comment (§3). */
function commentExpected(state: RunState): boolean {
    return state !== 'awaiting_approval' && state !== 'superseded' && state !== 'cancelled';
}

function checkViewOf(row: RuntimePublication | undefined): PublicationKindView {
    if (!row) return { status: 'pending' };
    // A check published as queued or in progress is on the PR, but not its result yet.
    if (row.status === 'published' && (row.checkRank ?? 0) < CHECK_STATUS_RANK.completed) {
        return { ...base(row), status: 'pending' };
    }
    return rowView(row);
}

function commentViewOf(
    row: RuntimePublication | undefined,
    showing: CommentPhase | undefined,
): PublicationKindView {
    const view = row ? rowView(row) : { status: 'pending' as const };
    return view.status === 'pending' && showing ? { ...view, showing } : view;
}

function rowView(row: RuntimePublication): PublicationKindView {
    switch (row.status) {
        case 'published':
            return { ...base(row), status: 'published', ...(row.fallback ? { fallback: true } : {}) };
        case 'skipped':
            return { ...base(row), status: 'skipped', ...shownReason(row.reason) };
        case 'failed':
            return row.redrive?.gaveUpAt
                ? { ...base(row), status: 'failed' }
                : { ...base(row), status: 'pending', retrying: true };
        case 'publishing':
            return { ...base(row), status: 'pending' };
    }
}

const base = (row: RuntimePublication): Pick<PublicationKindView, 'at' | 'redriveAttempts'> => ({
    at: row.updatedAt,
    ...(row.redrive?.attempts ? { redriveAttempts: row.redrive.attempts } : {}),
});

const shownReason = (reason: string | undefined): Pick<PublicationKindView, 'reason'> =>
    (SHOWN_SKIP_REASONS as readonly string[]).includes(reason ?? '')
        ? { reason: reason as ShownSkipReason }
        : {};

/** The latest progress phase whose comment was published. */
function lastShownPhase(
    rowOf: (phase: CommentPhase) => RuntimePublication | undefined,
): CommentPhase | undefined {
    return [...COMMENT_PHASES].reverse().find((phase) => rowOf(phase)?.status === 'published');
}
