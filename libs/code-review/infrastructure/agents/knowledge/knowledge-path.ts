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

/**
 * Resolve a file the model asked for under a skill folder. References are one
 * level deep (`NOTES.md`, `references/codes.md`), as the skill format expects;
 * anything deeper or outside the folder is refused.
 */
export function resolveInsideFolder(
    folder: string,
    relative: string,
): string | null {
    const normalized = normalizeRepoPath(relative);
    if (!normalized) return null;
    if (normalized.split('/').length > 2) return null;
    return `${folder}/${normalized}`;
}
