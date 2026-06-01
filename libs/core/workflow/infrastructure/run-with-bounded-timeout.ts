/**
 * Races `p` against a hard time bound. If the underlying op exceeds `ms`,
 * the returned promise rejects with a labeled error (so logs disambiguate
 * which bounded call timed out). On success, the timer is cleared so no
 * orphan setTimeout handles linger.
 *
 * Used by WorkflowJobConsumer to bound `inboxRepository.releaseLock` — a
 * slow Mongo write would otherwise keep an AMQP delivery unacked forever.
 */
export async function runWithBoundedTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let tid: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<never>((_, reject) => {
        tid = setTimeout(
            () => reject(new Error(`${label} bounded timeout after ${ms}ms`)),
            ms,
        );
    });
    try {
        return await Promise.race([p, timeoutP]);
    } finally {
        if (tid) clearTimeout(tid);
    }
}
