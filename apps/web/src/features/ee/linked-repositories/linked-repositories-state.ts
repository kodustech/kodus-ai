/**
 * Enterprise UI helpers for linked repositories (path under features/ee →
 * Enterprise License; see license_ee.md).
 */
import type { LinkedRepositoryConfig } from "src/app/(app)/settings/code-review/_types";

/** Soft cap mirrored from backend MAX_LINKED_REPOSITORIES (#1576). */
export const MAX_LINKED_REPOSITORIES_UI = 3;

export function normalizeLinkedRepositories(
    value: LinkedRepositoryConfig[] | undefined | null,
): LinkedRepositoryConfig[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (entry) =>
            entry &&
            typeof entry.repository === "string" &&
            entry.repository.trim().length > 0,
    );
}

/**
 * Pure add helper used by the form controller and unit tests.
 * No-ops when at soft cap or when the fullName is already linked.
 */
export function addLinkedRepository(
    current: LinkedRepositoryConfig[] | undefined | null,
    fullName: string,
): LinkedRepositoryConfig[] {
    const links = normalizeLinkedRepositories(current);
    if (links.length >= MAX_LINKED_REPOSITORIES_UI) return links;
    if (
        links.some(
            (l) => l.repository.toLowerCase() === fullName.toLowerCase(),
        )
    ) {
        return links;
    }
    return [
        ...links,
        { repository: fullName, instructions: "", ref: "" },
    ];
}
