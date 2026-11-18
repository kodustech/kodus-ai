import { createTwoFilesPatch } from 'diff';

/**
 * Longest a single file diff may take. A file whose diff runs past it gets no
 * patch instead of holding the review.
 */
export const AZURE_FILE_DIFF_TIMEOUT_MS = 60_000;

/**
 * Unified patch of one file, computed without blocking the event loop.
 *
 * The synchronous `createTwoFilesPatch` is Myers' O(N·D): on a large file
 * that differs on most lines from an old base commit it ran for 75–269s
 * inside one call (Azure Repos, Nov 17–18 2026), freezing the worker's
 * event loop until the ECS health check killed it with every job in
 * flight. With a `callback` the library computes the same diff in chunks
 * and yields to the event loop between them (setTimeout), and `timeout`
 * makes it give up on a pathological file: the promise resolves to
 * `undefined` and the caller treats the file as having no patch.
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
    return new Promise((resolve) => {
        createTwoFilesPatch(
            oldFileName,
            newFileName,
            oldStr,
            newStr,
            oldHeader,
            newHeader,
            {
                context: 3,
                timeout: timeoutMs,
                callback: (patch) => resolve(patch),
            },
        );
    });
}
