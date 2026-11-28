import { artifactOwner, planArtifacts } from './artifacts';

// docs/runtime/e2e-suites.md section 7 and D8: only the artifacts of failed specs are kept, each within its kind's size and
// all within the suite's budget; what is kept is chosen here, before a byte is read off the host.

const MIB = 1024 * 1024;
const specs = ['cypress/e2e/cart.cy.ts', 'cypress/e2e/profile.cy.ts', 'cypress/e2e/admin/cart.cy.ts'];

describe('which spec an artifact belongs to', () => {
    it('a screenshot or video named after the spec path belongs to it', () => {
        expect(artifactOwner('cypress/screenshots/cypress/e2e/cart.cy.ts/fail.png', specs)).toBe('cypress/e2e/cart.cy.ts');
        expect(artifactOwner('videos/cypress/e2e/profile.cy.ts.webm', specs)).toBe('cypress/e2e/profile.cy.ts');
    });
    it('the longest spec path that matches wins, so the admin spec never gets the other one\'s files', () => {
        expect(artifactOwner('cypress/screenshots/cypress/e2e/admin/cart.cy.ts/fail.png', specs)).toBe('cypress/e2e/admin/cart.cy.ts');
    });
    it('a runner that names the directory by the spec file name only still finds it, and an unrelated file belongs to none', () => {
        expect(artifactOwner('cypress/screenshots/profile.cy.ts/fail.png', specs)).toBe('cypress/e2e/profile.cy.ts');
        expect(artifactOwner('cypress/screenshots/readme.png', specs)).toBeUndefined();
    });
    it('a name that only contains a spec name inside another word is not a match', () => {
        expect(artifactOwner('shots/xcart.cy.tsx/fail.png', ['cypress/e2e/cart.cy.ts'])).toBeUndefined();
    });
});

describe('what is kept', () => {
    const file = (path: string, bytes: number) => ({ path, bytes });
    const plan = (files: ReturnType<typeof file>[], over: Partial<Parameters<typeof planArtifacts>[0]> = {}) =>
        planArtifacts({ files, specs, failed: ['cypress/e2e/cart.cy.ts'], remainingBytes: 200 * MIB, ...over });

    it('keeps the files of failed specs and drops those of passed ones, even a video', () => {
        const r = plan([file('s/cypress/e2e/cart.cy.ts/fail.png', 1000), file('s/cypress/e2e/profile.cy.ts/ok.png', 1000), file('v/cypress/e2e/profile.cy.ts.webm', MIB)]);
        expect(r.keep.map((k) => k.path)).toEqual(['s/cypress/e2e/cart.cy.ts/fail.png']);
        expect(r.drop).toEqual([
            { path: 's/cypress/e2e/profile.cy.ts/ok.png', reason: 'passed_spec' },
            { path: 'v/cypress/e2e/profile.cy.ts.webm', reason: 'passed_spec' },
        ]);
    });

    it('drops what no spec owns, what is of a type the evidence does not hold, and what is over its kind\'s size', () => {
        const r = plan([file('x/readme.png', 10), file('s/cypress/e2e/cart.cy.ts/run.mp4', 10), file('s/cypress/e2e/cart.cy.ts/big.png', 3 * MIB), file('s/cypress/e2e/cart.cy.ts/ok.png', 10)]);
        expect(r.keep.map((k) => k.path)).toEqual(['s/cypress/e2e/cart.cy.ts/ok.png']);
        expect(Object.fromEntries(r.drop.map((d) => [d.path, d.reason]))).toEqual({ 'x/readme.png': 'unattributed', 's/cypress/e2e/cart.cy.ts/run.mp4': 'unsupported_type', 's/cypress/e2e/cart.cy.ts/big.png': 'too_large' });
    });

    it('stops at the suite budget: what fits is kept in path order, the rest is dropped as over budget, never partly stored', () => {
        const r = plan([file('s/cypress/e2e/cart.cy.ts/a.png', MIB), file('s/cypress/e2e/cart.cy.ts/b.png', MIB), file('s/cypress/e2e/cart.cy.ts/c.png', MIB)], { remainingBytes: 2 * MIB + 10 });
        expect(r.keep.map((k) => k.path)).toEqual(['s/cypress/e2e/cart.cy.ts/a.png', 's/cypress/e2e/cart.cy.ts/b.png']);
        expect(r.drop).toEqual([{ path: 's/cypress/e2e/cart.cy.ts/c.png', reason: 'budget' }]);
        expect(r.keptBytes).toBe(2 * MIB);
    });

    it('keeps nothing when no spec failed', () => {
        expect(plan([file('s/cypress/e2e/cart.cy.ts/a.png', 10)], { failed: [] }).keep).toEqual([]);
    });
});
