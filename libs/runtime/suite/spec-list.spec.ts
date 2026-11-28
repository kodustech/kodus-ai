import { MAIN_SPECS_MAX, mainSpecsOfTree, specListOf } from './spec-list';

const listed = [
    { path: 'cypress/e2e/a.cy.ts', sizeBytes: 100 },
    { path: 'cypress/e2e/b.cy.ts', sizeBytes: 200 },
    { path: 'cypress/e2e/notes.md', sizeBytes: 5 },
];

describe('the spec list a suite run uses', () => {
    it('keeps what the spec glob matches in the listing of main, sorted', () => {
        const out = specListOf({ glob: 'cypress/e2e/**/*.cy.ts', listed: [...listed].reverse() });
        expect(out.map((s) => s.path)).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/b.cy.ts']);
        expect(out[1].sizeBytes).toBe(200);
    });

    it('adds a spec the PR adds (it is not on main) and drops one the PR removes', () => {
        const out = specListOf({
            glob: 'cypress/e2e/**/*.cy.ts',
            listed,
            changedFiles: ['cypress/e2e/new.cy.ts', 'cypress/e2e/a.cy.ts', 'src/app.ts'],
            removedFiles: ['cypress/e2e/b.cy.ts'],
        });
        expect(out.map((s) => s.path)).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/new.cy.ts']);
        // A spec main does not have has no size to balance by: zero, so it counts as the average of the known ones.
        expect(out.find((s) => s.path === 'cypress/e2e/new.cy.ts')?.sizeBytes).toBe(0);
    });

    it('reads the glob and the changed files relative to the suite directory', () => {
        const out = specListOf({
            glob: 'cypress/e2e/**/*.cy.ts',
            cwd: 'apps/dashboard',
            listed,
            changedFiles: ['apps/dashboard/cypress/e2e/new.cy.ts', 'apps/other/cypress/e2e/foreign.cy.ts'],
            removedFiles: ['apps/dashboard/cypress/e2e/b.cy.ts'],
        });
        expect(out.map((s) => s.path)).toEqual(['cypress/e2e/a.cy.ts', 'cypress/e2e/new.cy.ts']);
    });

    it('limits the list to the specs a retry names: they ran in the run being retried, so a spec only the PR has is kept, with its size when main knows it', () => {
        const out = specListOf({ glob: 'cypress/e2e/**/*.cy.ts', listed, only: ['cypress/e2e/b.cy.ts', 'cypress/e2e/pr-only.cy.ts'] });
        expect(out).toEqual([{ path: 'cypress/e2e/b.cy.ts', sizeBytes: 200 }, { path: 'cypress/e2e/pr-only.cy.ts', sizeBytes: 0 }]);
    });
});

describe("main's spec files from the repository's tree (no listing host)", () => {
    const tree = [
        { path: 'apps/web/cypress/e2e/b.cy.ts', size: 300 },
        { path: 'apps/web/cypress/e2e/a.cy.ts', size: 120 },
        { path: 'apps/web/cypress/e2e/notes.md', size: 9 },
        { path: 'apps/web/node_modules/pkg/cypress/e2e/x.cy.ts', size: 50 },
        { path: 'apps/api/cypress/e2e/c.cy.ts', size: 70 },
        { path: 'apps/web/cypress/e2e/unknown.cy.ts', size: -1 },
    ];
    it("gives what the listing host's find gives: under cwd, matching the glob, never node_modules, sorted, with sizes", () => {
        expect(mainSpecsOfTree(tree, { glob: 'cypress/e2e/**/*.cy.ts', cwd: 'apps/web' })).toEqual([
            { path: 'cypress/e2e/a.cy.ts', sizeBytes: 120 },
            { path: 'cypress/e2e/b.cy.ts', sizeBytes: 300 },
            { path: 'cypress/e2e/unknown.cy.ts', sizeBytes: 0 },
        ]);
    });
    it('gives no list past the bound, so the listing host lists them instead of a cut list', () => {
        const many = Array.from({ length: MAIN_SPECS_MAX + 1 }, (_, i) => ({ path: `e2e/s${i}.cy.ts`, size: 1 }));
        expect(mainSpecsOfTree(many, { glob: 'e2e/*.cy.ts' })).toBeNull();
    });
});
