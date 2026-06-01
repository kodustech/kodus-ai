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
    timeoutMessage: string,
): Promise<T> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(timeoutMessage));
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
