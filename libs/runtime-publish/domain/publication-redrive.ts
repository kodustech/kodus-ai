import type { RuntimePublishRequested } from '@libs/runtime/run';

import type { RuntimePublication } from './runtime-publication';

// The product re-drives a final publication the broker lost. A failed
// delivery is retried through workflow.exchange.delayed, and a retry that
// never comes back (a broken delayed exchange, a dead-lettered message) would
// otherwise leave the check open and the PR comment at "Writing the report"
// forever. The sweeper publishes the stored request again through the same
// use case: the idempotency key, the comment slot, the stale-comment order
// and the check status rank all still apply.

/** A final publication untouched this long, failed or with an expired lease, is re-driven. */
export const REDRIVE_AFTER_MS = 2 * 60 * 1000;

/** Re-deliveries of the stored request before the sweeper stops (a comment gets one fallback on top). */
export const MAX_REDRIVE_ATTEMPTS = 5;

/** Rows taken per sweep: a backlog drains over a few ticks instead of one burst on the platform. */
export const REDRIVE_BATCH = 20;

/**
 * Largest request kept with a publication. The schema bounds a report to
 * about 250 KiB; the Runtime's check summary is never rendered, so it is the
 * first thing dropped when a request does not fit.
 */
export const MAX_STORED_REQUEST_BYTES = 256 * 1024;

/** What the product says on the PR is final: the completed check, or the comment with the report. */
export function isFinalPublication(
    msg: Pick<RuntimePublishRequested, 'kind' | 'check' | 'report'>,
): boolean {
    return msg.kind === 'check'
        ? msg.check?.status === 'completed'
        : !!msg.report;
}

/**
 * The request to store with a final publication, or undefined when it is not
 * final or does not fit. Only a request that passed the strict schema reaches
 * here, and a redrive runs it through the schema again.
 */
export function storableRequestOf(
    msg: RuntimePublishRequested,
): RuntimePublishRequested | undefined {
    if (!isFinalPublication(msg)) return undefined;
    if (fits(msg)) return msg;
    if (!msg.check) return undefined;
    const trimmed: RuntimePublishRequested = {
        ...msg,
        check: { ...msg.check, summary: '' },
    };
    return fits(trimmed) ? trimmed : undefined;
}

const fits = (value: unknown) =>
    Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_STORED_REQUEST_BYTES;

export type RedriveStep = 'redrive' | 'fallback' | 'give_up';

/**
 * What the sweeper does with a stale row whose attempts so far are `attempts`:
 * publish the stored request again; past the last attempt, post the short
 * fallback once (the notice comment, or the neutral check); then stop.
 */
export function nextRedriveStep(
    row: Pick<RuntimePublication, 'kind' | 'request' | 'redrive'>,
): RedriveStep {
    const attempts = row.redrive?.attempts ?? 0;
    if (attempts < MAX_REDRIVE_ATTEMPTS) return 'redrive';
    if (attempts === MAX_REDRIVE_ATTEMPTS && hasFallback(row)) return 'fallback';
    return 'give_up';
}

/**
 * A final publication with a shorter way to say its result: the report
 * comment (a notice that links to Kodus) and the completed check (closed
 * neutral, so a required check never stays open on the PR).
 */
export function hasFallback(
    row: Pick<RuntimePublication, 'kind' | 'request'>,
): boolean {
    return row.kind === 'comment'
        ? !!row.request?.report
        : row.request?.check?.status === 'completed';
}

/** `staleBefore` for a sweep at `now`. */
export const staleBeforeOf = (now: Date) =>
    new Date(now.getTime() - REDRIVE_AFTER_MS).toISOString();
