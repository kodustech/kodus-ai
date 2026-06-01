import { resolveTouchedDirectoryIds } from './resolve-touched-directories';

describe('resolveTouchedDirectoryIds', () => {
    it('returns an empty list when no directories are configured', () => {
        expect(
            resolveTouchedDirectoryIds(['apps/web/src/foo.ts'], []),
        ).toEqual([]);
    });

    it('returns an empty list when no files were changed', () => {
        expect(
            resolveTouchedDirectoryIds(
                [],
                [{ id: 'd1', path: 'apps/web' }],
            ),
        ).toEqual([]);
    });

    it('matches a file nested inside the configured directory path', () => {
        const result = resolveTouchedDirectoryIds(
            ['apps/web/src/components/Foo.tsx'],
            [{ id: 'd1', path: 'apps/web' }],
        );
        expect(result).toEqual(['d1']);
    });

    it('matches a file located exactly at the directory root', () => {
        const result = resolveTouchedDirectoryIds(
            ['apps/web'],
            [{ id: 'd1', path: 'apps/web' }],
        );
        expect(result).toEqual(['d1']);
    });

    it('does NOT match a sibling whose path starts with the directory name but is different', () => {
        const result = resolveTouchedDirectoryIds(
            ['apps/web2/foo.ts'],
            [{ id: 'd1', path: 'apps/web' }],
        );
        expect(result).toEqual([]);
    });

    it('normalizes trailing slashes on directory paths', () => {
        const result = resolveTouchedDirectoryIds(
            ['apps/web/src/foo.ts'],
            [{ id: 'd1', path: 'apps/web/' }],
        );
        expect(result).toEqual(['d1']);
    });

    it('normalizes leading slashes on directory paths (`/docker` vs `docker/...`)', () => {
        const result = resolveTouchedDirectoryIds(
            ['docker/postgres/init.sql'],
            [{ id: 'd1', path: '/docker' }],
        );
        expect(result).toEqual(['d1']);
    });

    it('returns multiple ids when files touch multiple directories', () => {
        const result = resolveTouchedDirectoryIds(
            ['apps/web/src/foo.ts', 'libs/core/util.ts'],
            [
                { id: 'd1', path: 'apps/web' },
                { id: 'd2', path: 'libs/core' },
                { id: 'd3', path: 'apps/mobile' },
            ],
        );
        expect(result.sort()).toEqual(['d1', 'd2']);
    });

    it('returns each id at most once even when multiple files match the same directory', () => {
        const result = resolveTouchedDirectoryIds(
            [
                'apps/web/src/a.ts',
                'apps/web/src/b.ts',
                'apps/web/src/c.ts',
            ],
            [{ id: 'd1', path: 'apps/web' }],
        );
        expect(result).toEqual(['d1']);
    });

    it('returns multiple ids when overlapping directories both cover the same file', () => {
        const result = resolveTouchedDirectoryIds(
            ['docker/postgres/init.sql'],
            [
                { id: 'd-docker', path: '/docker' },
                { id: 'd-postgres', path: '/docker/postgres' },
            ],
        );
        expect(result.sort()).toEqual(['d-docker', 'd-postgres']);
    });

    it('skips entries whose path normalizes to empty', () => {
        const result = resolveTouchedDirectoryIds(
            ['apps/web/src/foo.ts'],
            [{ id: 'd1', path: '/' }],
        );
        expect(result).toEqual([]);
    });
});
