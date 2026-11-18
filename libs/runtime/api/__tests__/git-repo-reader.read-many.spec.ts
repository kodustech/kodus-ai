import { routesReaching } from '@libs/runtime/planner/import-graph/reach';

import { GitRepoReader, GIT_READ_MANY_PARALLEL } from '../application/recipe-author/git-repo-reader';

// v-core N5 (P15): the import graph walks one reader call per batch read, so
// a reader without readMany stopped at 300 file reads. The Git reader now
// reads a batch in one call of the walk, a few files at a time.

const target = { organizationId: 'org-1', teamId: 'team-1', repositoryId: 'repo-1', repositoryName: 'acme/shop', sha: 'a'.repeat(40) };

/** A chain of modules, each importing the next; the last one declares a route. */
function chainRepo(length: number) {
    const files = new Map<string, string>();
    for (let i = 0; i < length; i++) files.set(`src/m${i}.ts`, i === length - 1 ? "app.get('/deep', handler);\n" : `import './m${i + 1}';\n`);
    return files;
}

describe('GitRepoReader.readMany', () => {
    it('reads each path of a batch, a few at a time, and a missing or refused one as none', async () => {
        let inFlight = 0;
        let most = 0;
        const git = {
            readFileAtCommit: async ({ path }: { path: string }) => {
                inFlight++;
                most = Math.max(most, inFlight);
                await new Promise((r) => setImmediate(r));
                inFlight--;
                return path === 'missing.ts' ? null : `text of ${path}`;
            },
        };
        const reader = new GitRepoReader(git as any, target);
        const paths = [...Array.from({ length: 20 }, (_, i) => `f${i}.ts`), 'missing.ts', '../escape.ts'];
        const out = await reader.readMany(paths, 64);
        expect(out.get('f3.ts')).toBe('text of f3.ts');
        expect(out.get('missing.ts')).toBeNull();
        expect(out.get('../escape.ts')).toBeNull();
        expect(most).toBeLessThanOrEqual(GIT_READ_MANY_PARALLEL);
        expect(most).toBeGreaterThan(1);
    });

    it('a Git API failure fails the batch, never reads as no file', async () => {
        const reader = new GitRepoReader({ readFileAtCommit: async () => Promise.reject(new Error('HTTP 502')) } as any, target);
        await expect(reader.readMany(['a.ts'], 64)).rejects.toThrow('HTTP 502');
    });

    it("counts a batch as one call of the import graph's walk, so a walk bounded in calls still reaches the route", async () => {
        // 40 other modules beside the changed one; the route file that imports it is read with them.
        const files = new Map<string, string>(Array.from({ length: 40 }, (_, i) => [`src/a${String(i).padStart(2, '0')}.ts`, 'export const x = 1;\n']));
        files.set('src/changed.ts', 'export const changed = 1;\n');
        files.set('src/zz.ts', "import { changed } from './changed';\napp.get('/deep', () => changed);\n");
        const git = {
            readFileAtCommit: async ({ path }: { path: string }) => files.get(path) ?? null,
            listFilesAtCommit: async () => [...files.keys()],
        };
        const walk = (reader: any) => routesReaching({ base: reader, head: reader, cacheKey: `k-${Math.random()}`, budget: { calls: 6 } }, ['src/changed.ts'], ['src/changed.ts']);
        const batched = await walk(new GitRepoReader(git as any, target));
        expect(batched['src/changed.ts']?.map((r) => r.route)).toEqual(['GET /deep']);
        // The same reader without readMany (one file a call) runs out of calls first.
        const single = new GitRepoReader(git as any, target) as any;
        single.readMany = undefined;
        expect((await walk(single))['src/changed.ts']).toBeUndefined();
    });
});
