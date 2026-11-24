import { suiteDigestOf } from './digest';

// Section 7.1: a baseline is only evidence for a run of the same suite. The digest is of the suite block and the spec
// file list, so a changed command or glob, or an added spec, never reuses an old baseline.

const block = { runner: 'cypress', command: 'npx cypress run --spec "{specs}"', cwd: 'apps/dashboard', env: { BASE_URL: 'http://web:3000' }, resultsGlob: 'results/*.xml' } as const;

describe('suiteDigestOf', () => {
    it('is the same for the same suite whatever order its specs are listed in', () => {
        expect(suiteDigestOf(block, ['b.cy.ts', 'a.cy.ts'])).toBe(suiteDigestOf(block, ['a.cy.ts', 'b.cy.ts']));
    });

    it('changes with the command, the glob, the directory, the runner, an env value or the spec list', () => {
        const base = suiteDigestOf(block, ['a.cy.ts']);
        const others = [
            suiteDigestOf({ ...block, command: 'npx cypress run' }, ['a.cy.ts']),
            suiteDigestOf({ ...block, resultsGlob: 'out/*.xml' }, ['a.cy.ts']),
            suiteDigestOf({ ...block, cwd: 'apps/web' }, ['a.cy.ts']),
            suiteDigestOf({ ...block, runner: 'playwright' }, ['a.cy.ts']),
            suiteDigestOf({ ...block, env: { BASE_URL: 'http://web:4000' } }, ['a.cy.ts']),
            suiteDigestOf(block, ['a.cy.ts', 'b.cy.ts']),
            suiteDigestOf(block, ['a.cy.ts', 'c.cy.ts']),
        ];
        for (const d of others) expect(d).not.toBe(base);
        expect(new Set(others).size).toBe(others.length);
    });

    it('does not move with the order of the env entries, nor with a timeout or a shard ceiling (they do not change what runs)', () => {
        expect(suiteDigestOf({ ...block, env: { B: '1', A: '2' } }, ['a'])).toBe(suiteDigestOf({ ...block, env: { A: '2', B: '1' } }, ['a']));
        expect(suiteDigestOf({ ...block, shardTimeoutMs: 1, maxShards: 9 } as any, ['a'])).toBe(suiteDigestOf(block, ['a']));
    });
});
