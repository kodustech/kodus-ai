import { minimatch } from "minimatch";

/**
 * Normalizes a file path the way the backend does before matching, so the same
 * file spelled `./src/a.ts`, `/src/a.ts` or `src\a.ts` gets one answer.
 *
 * Mirrors `normalizeFilename` in libs/common/utils/glob-utils.ts. That module
 * can't be imported here: the web container mounts `libs/` at `/usr/libs` with
 * no `node_modules` above it, so anything under `libs/` that pulls a
 * third-party package (picomatch, in that file's case) fails to resolve at
 * build time. Same reason `match-file-against-rules.ts` re-implements it.
 */
function normalizeFilename(filename: string): string {
    return (filename || "")
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, "");
}

/**
 * Returns the first ignore pattern that would skip `filename`, or undefined
 * when the file survives every pattern. Case-sensitive with `dot: true`,
 * matching `isFileMatchingGlob` on the backend.
 */
export function findIgnoreMatch(
    filename: string,
    patterns: string[],
): string | undefined {
    const normalized = normalizeFilename(filename);
    if (!normalized) return undefined;

    return patterns.find((pattern) =>
        minimatch(normalized, pattern, { dot: true, nocase: false }),
    );
}
