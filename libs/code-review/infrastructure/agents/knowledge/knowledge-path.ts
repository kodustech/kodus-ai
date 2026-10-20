/**
 * Paths for skills and docs come from two untrusted places: the team's config
 * and the model (readSkillFile). Both end up in a `git` read of the target
 * branch, so a path is accepted only when it is a plain repository-relative
 * path: no absolute path, no `..` segment (even one that would normalize back
 * inside), no `.git` segment and no control characters.
 */

const MAX_PATH_LENGTH = 1024;

export function normalizeRepoPath(input: string): string | null {
    if (typeof input !== 'string' || !input || input.length > MAX_PATH_LENGTH) {
        return null;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\\]/.test(input)) return null;
    if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) return null;

    const segments: string[] = [];
    for (const segment of input.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..' || segment === '.git') return null;
        segments.push(segment);
    }

    return segments.length ? segments.join('/') : null;
}

/** At most this many files of a skill folder are listed and served. */
export const MAX_SKILL_FILES = 200;

/**
 * Resolve a file the model asked for under a skill folder, at any depth
 * (`NOTES.md`, `references/api/errors.md`). The path is plain and relative
 * (no `..`, no absolute path), so it cannot leave the folder; the caller still
 * serves it only when it is in the folder's listing, which leaves out
 * symlinks, and each read is size-capped.
 */
export function resolveInsideFolder(
    folder: string,
    relative: string,
): string | null {
    const normalized = normalizeRepoPath(relative);
    if (!normalized) return null;
    return `${folder}/${normalized}`;
}
