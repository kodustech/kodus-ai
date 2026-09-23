/**
 * Runs `fn` over `items` with at most `concurrency` in flight and starts no
 * new item after `deadline` (epoch ms). A check that outlives its runCheck
 * timeout loses every result it collected, so checks that fan out over
 * repositories or organizations bound themselves with this and report what
 * they did not get to instead.
 */
export async function mapWithinBudget<T, R>(
    items: T[],
    opts: { concurrency: number; deadline: number; now?: () => number },
    fn: (item: T) => Promise<R>,
): Promise<{ done: Array<{ item: T; result: R }>; skipped: T[] }> {
    const now = opts.now ?? Date.now;
    const done: Array<{ item: T; result: R; index: number }> = [];
    const skipped: T[] = [];
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            if (now() >= opts.deadline) {
                skipped.push(items[index]);
                continue;
            }
            done.push({
                item: items[index],
                result: await fn(items[index]),
                index,
            });
        }
    };

    await Promise.all(
        Array.from(
            { length: Math.min(opts.concurrency, items.length) },
            worker,
        ),
    );

    return {
        // keep the caller's order so the report reads the same run to run
        done: done
            .sort((a, b) => a.index - b.index)
            .map(({ item, result }) => ({ item, result })),
        skipped,
    };
}
