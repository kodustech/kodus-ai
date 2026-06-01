/**
 * Tests for directory group config resolution.
 *
 * Setup:
 *   Group ABC — folders: /src/a, /src/b, /src/c (shared config)
 *   Group D   — folders: /src/d (single folder config)
 *
 * Rules:
 *   - PR touches files in exactly 1 group → use that group's config
 *   - PR touches files in 2+ groups → fall back to repository config (undefined)
 *   - Files outside any group do NOT invalidate a single-group match
 *   - PR touches no groups → fall back to repository config (undefined)
 */

// Extracted logic matching CodeBaseConfigService.resolveConfigByDirectories
function resolveConfigByDirectories(
    repoConfig: any,
    affectedPaths: string[],
) {
    if (!repoConfig?.directories) {
        return undefined;
    }

    const normalizePath = (path: string): string => {
        return path.startsWith('/') ? path.substring(1) : path;
    };

    const isPathCoveredByDirectory = (
        normalizedDir: string,
        normalizedFile: string,
    ): boolean => {
        if (normalizedDir === '') {
            return true;
        }

        return (
            normalizedFile === normalizedDir ||
            normalizedFile.startsWith(normalizedDir + '/')
        );
    };

    const groupMatchers = repoConfig.directories.flatMap((group: any) => {
        const folders =
            group.folders?.length > 0
                ? group.folders
                : group.path
                  ? [{ path: group.path }]
                  : [];
        return folders.map((folder: any) => ({
            group,
            normalizedPath: normalizePath(folder.path),
        }));
    });

    const matchingEntries = groupMatchers.filter(
        ({ normalizedPath }: any) =>
            affectedPaths.some((filePath: string) => {
                const normalizedFile = normalizePath(filePath);
                return isPathCoveredByDirectory(normalizedPath, normalizedFile);
            }),
    );

    const matchingGroupIds = new Set(
        matchingEntries.map(({ group }: any) => group.id),
    );
    const matchingGroups = repoConfig.directories.filter((g: any) =>
        matchingGroupIds.has(g.id),
    );

    if (matchingGroups.length === 1) {
        return matchingGroups[0];
    }

    return undefined;
}

const groupABC = {
    id: 'group-abc',
    name: 'a',
    isSelected: true,
    configs: { reviewOptions: { bug: true } },
    folders: [
        { id: 'f-a', name: 'a', path: '/src/a' },
        { id: 'f-b', name: 'b', path: '/src/b' },
        { id: 'f-c', name: 'c', path: '/src/c' },
    ],
};

const groupD = {
    id: 'group-d',
    name: 'd',
    isSelected: true,
    configs: { reviewOptions: { security: true } },
    folders: [{ id: 'f-d', name: 'd', path: '/src/d' }],
};

const repoConfig = {
    id: 'repo-1',
    name: 'repo-1',
    isSelected: true,
    configs: {},
    directories: [groupABC, groupD],
};

describe('resolveConfigByDirectories', () => {
    it('returns group ABC when PR touches A, B and E (1 group + unclassified)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/a/file.ts',
            '/src/b/file.ts',
            '/src/e/file.ts',
        ]);
        expect(result).toBeDefined();
        expect(result.id).toBe('group-abc');
    });

    it('returns undefined when PR touches A, C and D (2 groups)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/a/file.ts',
            '/src/c/file.ts',
            '/src/d/file.ts',
        ]);
        expect(result).toBeUndefined();
    });

    it('returns group D when PR touches D and E (1 group + unclassified)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/d/file.ts',
            '/src/e/file.ts',
        ]);
        expect(result).toBeDefined();
        expect(result.id).toBe('group-d');
    });

    it('returns undefined when PR touches D, E, F and B (2 groups)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/d/file.ts',
            '/src/e/file.ts',
            '/src/f/file.ts',
            '/src/b/file.ts',
        ]);
        expect(result).toBeUndefined();
    });

    it('returns group ABC when PR touches A, B, C and F (1 group + unclassified)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/a/file.ts',
            '/src/b/file.ts',
            '/src/c/file.ts',
            '/src/f/file.ts',
        ]);
        expect(result).toBeDefined();
        expect(result.id).toBe('group-abc');
    });

    it('returns undefined when PR touches only E and F (no groups)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/e/file.ts',
            '/src/f/file.ts',
        ]);
        expect(result).toBeUndefined();
    });

    it('returns group ABC when PR touches only A and C (pure match, no external paths)', () => {
        const result = resolveConfigByDirectories(repoConfig, [
            '/src/a/file.ts',
            '/src/c/file.ts',
        ]);
        expect(result).toBeDefined();
        expect(result.id).toBe('group-abc');
    });

    it('handles legacy format (path instead of folders)', () => {
        const legacyRepoConfig = {
            ...repoConfig,
            directories: [
                {
                    id: 'legacy-dir',
                    name: 'api',
                    isSelected: true,
                    configs: { reviewOptions: { bug: true } },
                    path: '/src/api',
                    // no folders field
                },
            ],
        };
        const result = resolveConfigByDirectories(legacyRepoConfig, [
            '/src/api/controller.ts',
            '/src/other/file.ts',
        ]);
        expect(result).toBeDefined();
        expect(result.id).toBe('legacy-dir');
    });
});
