import { publishKey, type RuntimePublishRequested } from '@libs/runtime/run';

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

/** The longest wait between two redrives of a row. */
export const MAX_REDRIVE_BACKOFF_MS = 60 * 60 * 1000;

/**
 * How long a row redriven `attempts` times stays untouched before the next
 * try: REDRIVE_AFTER_MS, then doubled per attempt (2, 2, 4, 8, 16, 32 min).
 * The attempts then span about an hour, so an org whose platform quota is
 * exhausted for an hour (the services answer a rate limit as null, so it
 * cannot be told apart) still sees its result instead of a given-up row.
 */
export function redriveBackoffMs(attempts: number): number {
    return Math.min(MAX_REDRIVE_BACKOFF_MS, REDRIVE_AFTER_MS * 2 ** Math.max(0, attempts - 1));
}

/**
 * Re-deliveries of the stored request before the sweeper stops. A final
 * publication then gets one fallback on top (hasFallback): the report comment
 * a short notice, the completed check closed failed.
 */
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
 * fallback once (the notice comment, or the failed check); then stop.
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
 * comment (a notice that links to Kodus) and the completed verdict check
 * (closed failed, so a required check never stays open on the PR and never
 * passes without a verdict). The fork check waiting for a maintainer has none:
 * it carries no result, and a "result not posted" would be false.
 */
export function hasFallback(
    row: Pick<RuntimePublication, 'kind' | 'request'>,
): boolean {
    const request = row.request;
    if (row.kind === 'comment') return !!request?.report;
    return (
        request?.check?.status === 'completed' &&
        request.key === publishKey(request.runId, request.attempt, 'check')
    );
}

/** `staleBefore` for a sweep at `now`. */
export const staleBeforeOf = (now: Date) =>
    new Date(now.getTime() - REDRIVE_AFTER_MS).toISOString();
