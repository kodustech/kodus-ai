export class WorkflowJobTimeoutError extends Error {
    readonly name = 'WorkflowJobTimeoutError';
}

/**
 * Runs `work` with a hard deadline.
 *
 * When the deadline hits:
 *   1. The created AbortController is aborted, propagating cancellation to
 *      any callee that wires the signal into its async ops (LLM SDK,
 *      fetch, octokit, etc.). Without that wiring, work continues running
 *      in the background — Promise.race alone cannot cancel a pending
 *      promise.
 *   2. The race rejects with `timeoutMessage`, so the caller's catch block
 *      runs immediately and can do its cleanup chain.
 *
 * Extracted from JobProcessorRouterService for standalone unit testing
 * (the router itself drags in the entire code-review DI graph through
 * processor imports).
 */
export async function runWithTimeout<T>(
    work: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    timeout: string | Error,
): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            const error =
                typeof timeout === 'string' ? new Error(timeout) : timeout;
            controller.abort(typeof timeout === 'string' ? undefined : error);
            reject(error);
        }, timeoutMs);
    });

    try {
        return await Promise.race([work(controller.signal), timeoutPromise]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}
