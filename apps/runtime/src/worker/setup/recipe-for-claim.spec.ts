import { recipeForClaimOf } from './recipe-for-claim';

const base = { path: '.kodus/workspace.yaml', sha: 'a'.repeat(40), state: 'found' as const, content: 'version: 1\n', digest: 'sha256:d' };
const compose = [{ path: '.kodus/compose.yaml', content: 'services: {}\n' }];

describe('recipeForClaimOf', () => {
    it("sends a committed recipe's build files in fill_missing mode, so the cell never touches a file the PR has", () => {
        expect(recipeForClaimOf({ ...base, buildFiles: compose })).toEqual({ path: base.path, content: 'version: 1\n', digest: 'sha256:d', files: compose, filesMode: 'fill_missing' });
    });

    it("sends Kody's authored files as before, with no mode", () => {
        const out = recipeForClaimOf({ ...base, origin: 'authored', files: compose });
        expect(out).toEqual({ path: base.path, content: 'version: 1\n', digest: 'sha256:d', files: compose });
        expect(out).not.toHaveProperty('filesMode');
    });

    it('sends the authored files alone when a record somehow holds both', () => {
        const other = [{ path: '.kodus/Dockerfile', content: 'FROM node:22\n' }];
        expect(recipeForClaimOf({ ...base, files: compose, buildFiles: other })).toMatchObject({ files: compose });
        expect(recipeForClaimOf({ ...base, files: compose, buildFiles: other })).not.toHaveProperty('filesMode');
    });

    it('sends no files for a recipe the default branch lacks, or a record with none', () => {
        expect(recipeForClaimOf({ ...base, state: 'absent', content: undefined, buildFiles: compose })).toEqual({ path: base.path, content: null, digest: 'sha256:d' });
        expect(recipeForClaimOf(base)).toEqual({ path: base.path, content: 'version: 1\n', digest: 'sha256:d' });
        expect(recipeForClaimOf(undefined)).toBeUndefined();
    });
});
