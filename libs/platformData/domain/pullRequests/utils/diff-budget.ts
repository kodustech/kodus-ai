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
export const MAX_PATCH_CHARS_PER_FILE = 200_000;

// Headroom budget below the 16 MB BSON ceiling reserved for the rest of the
// document (suggestions, commits, metadata). 8 MB of embedded diffs leaves
// ample room for the non-diff payload even on very large PRs.
export const MAX_TOTAL_EMBEDDED_PATCH_CHARS = 8_000_000;

// Appended to a truncated diff body so downstream code and the reviewing LLM
// can tell the diff was capped rather than silently treating it as complete.
export const TRUNCATED_DIFF_MARKER =
    '\n---\n// diff truncated: the embedded-diff budget was exceeded; run the review with a narrower diff (e.g. per-commit) or split the PR into smaller PRs.\n';

export interface PatchBudgetResult {
    patch: string;
    truncated: boolean;
    consumed: number;
}

/**
 * Cap a single patch to `MAX_PATCH_CHARS_PER_FILE` and to the caller's
 * remaining aggregate budget. Returns the patch to persist (optionally a
 * leading window of the original plus `TRUNCATED_DIFF_MARKER`), whether it was
 * truncated, and how many characters of the aggregate budget it consumed.
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
        MAX_PATCH_CHARS_PER_FILE,
        Math.max(0, remainingTotalBudget),
    );
    if (patch.length <= allowance) {
        return { patch, truncated: false, consumed: patch.length };
    }
    if (allowance < TRUNCATED_DIFF_MARKER.length) {
        return { patch: '', truncated: true, consumed: 0 };
    }
    const bodyLen = allowance - TRUNCATED_DIFF_MARKER.length;
    return {
        patch: `${patch.slice(0, bodyLen)}${TRUNCATED_DIFF_MARKER}`,
        truncated: true,
        consumed: allowance,
    };
}

/**
 * Last-resort clamp applied in the repository: no single `files[].patch`
 * written by any path may exceed `MAX_PATCH_CHARS_PER_FILE`, so a future
 * caller that bypasses the service-level aggregate budget can never embed an
 * unbounded patch on its own.
 */
export function clampPatchForPersist(patch: string): string {
    if (patch.length <= MAX_PATCH_CHARS_PER_FILE) {
        return patch;
    }
    if (MAX_PATCH_CHARS_PER_FILE <= TRUNCATED_DIFF_MARKER.length) {
        return '';
    }
    const bodyLen = MAX_PATCH_CHARS_PER_FILE - TRUNCATED_DIFF_MARKER.length;
    return `${patch.slice(0, bodyLen)}${TRUNCATED_DIFF_MARKER}`;
}