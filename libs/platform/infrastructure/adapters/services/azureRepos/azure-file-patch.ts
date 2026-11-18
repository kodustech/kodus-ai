import { createTwoFilesPatch } from 'diff';

/**
 * Longest a single file diff may take. A file whose diff runs past it gets no
 * patch instead of holding the worker.
 */
export const AZURE_FILE_DIFF_TIMEOUT_MS = 60_000;

/**
 * Longest the synchronous attempt may hold the event loop. Almost every file
 * finishes well inside it (a 10k-line added file takes ~15ms); only a large
 * file that differs on most lines runs past it.
 */
export const AZURE_FILE_DIFF_SYNC_BUDGET_MS = 250;

/** Grace past the timeout before our own guard gives up on the library. */
const AZURE_FILE_DIFF_GUARD_SLACK_MS = 5_000;

/**
 * Unified patch of one file, without ever blocking the event loop for long.
 *
 * The synchronous `createTwoFilesPatch` is Myers' O(N·D): on a large file
 * that differs on most lines from an old base commit it ran for 75–269s
 * inside one call (Azure Repos, Nov 17–18 2026), freezing the worker until
 * the ECS health check killed it with every job in flight.
 *
 * Two steps:
 * 1. Synchronous, capped at {@link AZURE_FILE_DIFF_SYNC_BUDGET_MS}. Normal
 *    files keep their old latency (the yielding mode costs ~1ms per edit
 *    step: a 10k-line added file goes from ~15ms to ~11s).
 * 2. Only if that gives up: the library's callback mode, which computes the
 *    same diff in chunks and yields between them, for the rest of
 *    `timeoutMs`.
 *
 * Resolves to `undefined` when the diff does not finish in `timeoutMs`; the
 * caller then has no patch for the file, which the risk and approval checks
 * already treat as missing evidence.
 */
export function createFilePatchYielding(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader: string,
    newHeader: string,
    timeoutMs: number = AZURE_FILE_DIFF_TIMEOUT_MS,
): Promise<string | undefined> {
    const limitMs =
        Number.isFinite(timeoutMs) && timeoutMs > 0
            ? timeoutMs
            : AZURE_FILE_DIFF_TIMEOUT_MS;
    const startedAt = Date.now();

    const fast = createTwoFilesPatch(
        oldFileName,
        newFileName,
        oldStr,
        newStr,
        oldHeader,
        newHeader,
        {
            context: 3,
            timeout: Math.min(AZURE_FILE_DIFF_SYNC_BUDGET_MS, limitMs),
        },
    );
    if (fast !== undefined) return Promise.resolve(fast);

    const remainingMs = limitMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return Promise.resolve(undefined);

    return new Promise((resolve) => {
        // Our own bound too: the promise settles even if the library never
        // calls back, so a file can never hold the review forever.
        const guard = setTimeout(
            () => resolve(undefined),
            remainingMs + AZURE_FILE_DIFF_GUARD_SLACK_MS,
        );
        createTwoFilesPatch(
            oldFileName,
            newFileName,
            oldStr,
            newStr,
            oldHeader,
            newHeader,
            {
                context: 3,
                timeout: remainingMs,
                callback: (patch) => {
                    clearTimeout(guard);
                    resolve(patch);
                },
            },
        );
    });
}
