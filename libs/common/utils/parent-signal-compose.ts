/**
 * Wires a parent AbortSignal into a local AbortController.
 *
 * - If the parent has already aborted when called, the local controller
 *   is aborted synchronously.
 * - Otherwise, registers a one-shot listener that aborts the local
 *   controller when the parent does.
 *
 * Used by `runAgentLoop` so the router-level workflow timeout cancels the
 * agent's `generateText` call instead of leaving an LLM request running
 * ghost in the background.
 *
 * Returns a cleanup function that detaches the listener — call it in the
 * caller's `finally` block so the parent signal does not retain a
 * reference to the local controller after the work completes normally.
 */
export function composeAbortSignal(
    parent: AbortSignal | undefined,
    local: AbortController,
    onAbort?: () => void,
): () => void {
    if (!parent) return () => {};

    if (parent.aborted) {
        local.abort();
        return () => {};
    }

    const handler = () => {
        onAbort?.();
        local.abort();
    };
    parent.addEventListener('abort', handler, { once: true });
    return () => parent.removeEventListener('abort', handler);
}
