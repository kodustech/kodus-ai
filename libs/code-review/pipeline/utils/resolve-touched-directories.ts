/**
 * Returns the set of directory ids whose configured path covers at
 * least one of the changed files. A file "is in" a directory when its
 * path equals the directory path or starts with `<directory path>/`.
 * Both leading and trailing slashes on the directory path are
 * normalized so configs like `"/docker"` match changed files written
 * as `docker/...` (the standard form returned by git/PR providers).
 * Sibling prefixes (e.g. `apps/web` vs `apps/web2`) never collide.
 */
export function resolveTouchedDirectoryIds(
    changedFilePaths: string[],
    directories: ReadonlyArray<{ id: string; path: string }>,
): string[] {
    if (directories.length === 0 || changedFilePaths.length === 0) {
        return [];
    }

    const touched = new Set<string>();
    for (const directory of directories) {
        const normalized = directory.path
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
        if (normalized.length === 0) continue;
        const prefix = `${normalized}/`;
        const hit = changedFilePaths.some(
            (file) => file === normalized || file.startsWith(prefix),
        );
        if (hit) {
            touched.add(directory.id);
        }
    }
    return Array.from(touched);
}
