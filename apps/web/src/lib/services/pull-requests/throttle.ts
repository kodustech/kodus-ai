export type Throttled = (() => void) & { cancel: () => void };

/**
 * Runs `fn` at most once per `intervalMs`.
 *
 * The first call runs immediately. Calls that arrive while the interval is
 * still open are folded into a single run when it closes, so the last event of
 * a burst is never lost — only the ones in between.
 */
export const throttle = (fn: () => void, intervalMs: number): Throttled => {
    let lastRunAt: number | undefined;
    let pending: ReturnType<typeof setTimeout> | undefined;

    const run = () => {
        pending = undefined;
        lastRunAt = Date.now();
        fn();
    };

    const throttled = () => {
        if (pending !== undefined) return;

        const elapsed =
            lastRunAt === undefined ? intervalMs : Date.now() - lastRunAt;
        if (elapsed >= intervalMs) {
            run();
            return;
        }

        pending = setTimeout(run, intervalMs - elapsed);
    };

    throttled.cancel = () => {
        if (pending !== undefined) clearTimeout(pending);
        pending = undefined;
    };

    return throttled;
};
