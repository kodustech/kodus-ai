import { RECIPE_AUTHOR_REVISIONS, RECIPE_AUTHOR_VERSION, reauthorRevision, recipeAuthorRevision } from './recipe-author-version';

describe('the versions of the recipe author instructions', () => {
    it('go up one at a time from 1, each with a one-line reason', () => {
        expect(RECIPE_AUTHOR_REVISIONS.map((r) => r.version)).toEqual(RECIPE_AUTHOR_REVISIONS.map((_, i) => i + 1));
        expect(RECIPE_AUTHOR_REVISIONS.every((r) => r.reason.length > 0 && !r.reason.includes('\n') && r.reason.length <= 200)).toBe(true);
        expect(RECIPE_AUTHOR_VERSION).toBe(RECIPE_AUTHOR_REVISIONS.length);
    });

    it('a recipe asks to be written again only for a revision marked so, past its version, not tried yet', () => {
        const newest = [...RECIPE_AUTHOR_REVISIONS].reverse().find((r) => r.reauthor)!;
        expect(reauthorRevision(undefined, undefined)).toEqual(newest);
        expect(reauthorRevision(RECIPE_AUTHOR_VERSION, undefined)).toBeUndefined();
        expect(reauthorRevision(undefined, newest.version)).toBeUndefined();
    });

    // kr-nextjs (2026-11-13): written again under v2, it kept `next dev` because next/font/google could not reach Google
    // Fonts from a build. v3 puts the two hosts on the recommended list; only a recipe that names next/font/google
    // needs writing again for it, not every recipe Kody wrote.
    it('v3 asks again only a recipe whose notes or files name next/font/google', () => {
        const fonts = { recipe: 'version: 1\n', notes: 'The app imports next/font/google, so it runs next dev.' };
        const inFiles = { recipe: 'version: 1\n', files: [{ path: '.kodus/Dockerfile', content: '# next/font/google needs the network\nCMD ["pnpm", "dev"]\n' }] };
        const plain = { recipe: 'version: 1\n', notes: 'the compose file at the root' };
        expect(RECIPE_AUTHOR_VERSION).toBeGreaterThanOrEqual(3);
        expect(recipeAuthorRevision(3)).toMatchObject({ reauthor: true });
        expect(reauthorRevision(2, 2, fonts)?.version).toBe(3);
        expect(reauthorRevision(2, 2, inFiles)?.version).toBe(3);
        expect(reauthorRevision(2, 2, plain)).toBeUndefined();
        // A recipe of v1 that does not name it still gets v2, and v2 alone.
        expect(reauthorRevision(1, undefined, plain)?.version).toBe(2);
        expect(reauthorRevision(1, undefined, fonts)?.version).toBe(3);
    });
});
