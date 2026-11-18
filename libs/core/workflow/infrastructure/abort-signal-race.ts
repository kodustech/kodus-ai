import { isSlicePreemptedError } from '@libs/core/workflow/domain/errors/slice-preempted.error';

/**
 * Race a promise against an AbortSignal.
 *
 * If `signal` aborts before `work` settles, the returned promise rejects
 * with a `JobAbortedError`, or with `signal.reason` when that is a
 * SlicePreemptedError. The underlying `work` promise is NOT cancelled
 * (octokit / fetch do not expose a way to yank a sleeping request once
 * issued) — it will settle later in the background and its result is
 * discarded.
 *
 * Why we still want this: the caller can finally release the work item
 * (rabbit ack, p-limit slot, span close) instead of staying pinned until
 * the long-sleeping octokit retry-after wakes up. Letting one zombie
 * promise leak in the background is far cheaper than holding the worker
 * slot for the full sleep window.
 *
 * If `signal` is undefined or already aborted at call time, the behavior
 * matches `Promise.race` semantics: pass-through, or immediate rejection.
 */

function errorFromAbort(signal: AbortSignal): Error {
    return isSlicePreemptedError(signal.reason)
        ? (signal.reason as Error)
        : new JobAbortedError();
}

export class JobAbortedError extends Error {
    constructor(message = 'Job aborted by parent signal') {
        super(message);
        this.name = 'JobAbortedError';
    }
}

export async function raceWithAbortSignal<T>(
    work: Promise<T>,
    signal: AbortSignal | undefined,
): Promise<T> {
    if (!signal) return work;
    if (signal.aborted) throw errorFromAbort(signal);

    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(errorFromAbort(signal));
        signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
        return await Promise.race([work, abortPromise]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}
