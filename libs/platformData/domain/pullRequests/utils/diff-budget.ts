// Budgets for the unified diffs that get embedded into the `pullRequests`
// MongoDB document via `files[].patch`. MongoDB hard-caps a single BSON
// document at 16 MB (16_777_216 bytes). A PR that accumulates many large file
// patches (release/promotion PRs, big refactors) pushes the embedded array past
// that ceiling; the persist then throws `MongoBulkWriteError ... larger than
// 16777216`, and the review fails with a misleading "Unable to load or resolve
// the review configuration" instead of a diff-aware result (#1841).
//
// These constants bound the embedded diff payload so the document stays well
// under the cap, degrading diff coverage (with a visible truncation marker on
// the affected file) rather than failing the whole review.
//
// IMPORTANT: every budget here is expressed in **bytes**, not JS string length.
// `String#length` counts UTF-16 code units, while the 16 MB BSON ceiling is in
// UTF-8 bytes. A multibyte diff (CJK is ~3 bytes/char) measured by `.length`
// can reach 16-24 MB while still "fitting" an 8M-char budget, and the write
// blows up with the very MongoBulkWriteError this fix exists to prevent.
// `Buffer.byteLength(patch, 'utf8')` (via `utf8ByteLength`) is the unit that
// matches BSON.
export const MAX_PATCH_BYTES_PER_FILE = 200_000;

// Headroom budget below the 16 MB BSON ceiling reserved for the rest of the
// document (suggestions, commits, metadata). 8 MB of embedded diffs leaves
// ample room for the non-diff payload even on very large PRs.
export const MAX_TOTAL_EMBEDDED_PATCH_BYTES = 8_000_000;

// Appended to a truncated diff body so downstream code and the reviewing LLM
// can tell the diff was capped rather than silently treating it as complete.
export const TRUNCATED_DIFF_MARKER =
    '\n---\n// diff truncated: the embedded-diff budget was exceeded; run the review with a narrower diff (e.g. per-commit) or split the PR into smaller PRs.\n';

/**
 * UTF-8 byte length of a string — the unit MongoDB's BSON ceiling is measured
 * in (and therefore the unit every budget in this module uses). Falls back to
 * `String#length` where `Buffer` is unavailable so this stays usable in any
 * runtime the service is bundled for.
 */
export function utf8ByteLength(value: string): number {
    if (!value) {
        return 0;
    }
    if (typeof Buffer !== 'undefined') {
        return Buffer.byteLength(value, 'utf8');
    }
    return value.length;
}

/**
 * Longest prefix of `value` whose UTF-8 byte length does not exceed
 * `maxBytes`. Never splits a surrogate pair (which would emit a lone
 * surrogate and inflate the byte count), so the returned prefix always
 * measures <= `maxBytes`.
 */
function utf8Prefix(value: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    if (utf8ByteLength(value) <= maxBytes) {
        return value;
    }
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (utf8ByteLength(value.slice(0, mid)) <= maxBytes) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    // If the boundary lands right after a high surrogate its low surrogate
    // was excluded — drop the orphan so we never emit an invalid character.
    if (lo > 0 && lo < value.length) {
        const last = value.charCodeAt(lo - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
            lo -= 1;
        }
    }
    return value.slice(0, lo);
}

export interface PatchBudgetResult {
    patch: string;
    truncated: boolean;
    consumed: number;
}

/**
 * Cap a single patch to `MAX_PATCH_BYTES_PER_FILE` and to the caller's
 * remaining aggregate budget. Returns the patch to persist (optionally a
 * leading window of the original plus `TRUNCATED_DIFF_MARKER`), whether it was
 * truncated, and how many **bytes** of the aggregate budget it consumed.
 *
 * The produced patch is guaranteed to measure <= the allowance in UTF-8 bytes
 * (marker included), so the caller can keep a byte-accurate running total.
 *
 * When even the marker would not fit (aggregate budget exhausted for this
 * file), the patch is dropped entirely — the file still persists with its
 * metadata/suggestions and is filtered out of diff-based review downstream.
 */
export function budgetPatchForPersist(
    patch: string,
    remainingTotalBudget: number,
): PatchBudgetResult {
    if (!patch) {
        return { patch: '', truncated: false, consumed: 0 };
    }
    const allowance = Math.min(
        MAX_PATCH_BYTES_PER_FILE,
        Math.max(0, remainingTotalBudget),
    );
    const patchBytes = utf8ByteLength(patch);
    if (patchBytes <= allowance) {
        return { patch, truncated: false, consumed: patchBytes };
    }
    const markerBytes = utf8ByteLength(TRUNCATED_DIFF_MARKER);
    if (allowance < markerBytes) {
        return { patch: '', truncated: true, consumed: 0 };
    }
    const bodyBudgetBytes = allowance - markerBytes;
    const resultPatch = `${utf8Prefix(
        patch,
        bodyBudgetBytes,
    )}${TRUNCATED_DIFF_MARKER}`;
    return {
        patch: resultPatch,
        truncated: true,
        consumed: utf8ByteLength(resultPatch),
    };
}

/**
 * Last-resort clamp applied in the repository: no single `files[].patch`
 * written by any path may exceed `MAX_PATCH_BYTES_PER_FILE` **bytes**, so a
 * future caller that bypasses the service-level aggregate budget can never
 * embed an unbounded patch on its own.
 */
export function clampPatchForPersist(patch: string): string {
    return clampPatchForPersistWithFlag(patch).patch;
}

/**
 * Same as `clampPatchForPersist`, but also reports whether the patch had to be
 * truncated. The repository uses the flag to mirror `patchTruncated: true`
 * onto the sub-document, so a clamp applied at the storage layer is never
 * silently stale.
 */
export function clampPatchForPersistWithFlag(patch: string): {
    patch: string;
    truncated: boolean;
} {
    if (utf8ByteLength(patch) <= MAX_PATCH_BYTES_PER_FILE) {
        return { patch, truncated: false };
    }
    const markerBytes = utf8ByteLength(TRUNCATED_DIFF_MARKER);
    if (MAX_PATCH_BYTES_PER_FILE <= markerBytes) {
        return { patch: '', truncated: true };
    }
    const bodyBudgetBytes = MAX_PATCH_BYTES_PER_FILE - markerBytes;
    return {
        patch: `${utf8Prefix(patch, bodyBudgetBytes)}${TRUNCATED_DIFF_MARKER}`,
        truncated: true,
    };
}
