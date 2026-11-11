type VisibilitySource = Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
>;

/**
 * Calls `run` every `intervalMs`, but only while the page is visible.
 *
 * A plain `setInterval` keeps firing in a background tab (browsers slow it to
 * about once a minute, they do not stop it), so a PR page left open in a tab
 * nobody is looking at kept requesting its runs all day. Ticks that land while
 * the page is hidden are skipped; if any was skipped, `run` is called once as
 * soon as the page is visible again, so the reader does not come back to stale
 * data and wait for the next tick.
 *
 * Returns the function that stops it.
 */
export const pollWhileVisible = (
    run: () => void,
    intervalMs: number,
    source: VisibilitySource = document,
): (() => void) => {
    let skipped = false;

    const tick = () => {
        if (source.visibilityState === "hidden") {
            skipped = true;
            return;
        }
        run();
    };

    const onVisibilityChange = () => {
        if (source.visibilityState === "hidden" || !skipped) return;
        skipped = false;
        run();
    };

    const timer = setInterval(tick, intervalMs);
    source.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
        clearInterval(timer);
        source.removeEventListener("visibilitychange", onVisibilityChange);
    };
};
