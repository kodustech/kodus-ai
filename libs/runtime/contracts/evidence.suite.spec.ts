import { EVIDENCE_TYPES, evidenceKey, SUITE_ARTIFACT_BUDGET_BYTES, suiteArtifactKey, suiteArtifactLimit } from './evidence';

// docs/runtime/e2e-suites.md section 7 (build-plan step 18): a suite artifact is one object per failed spec's file, under the
// suite run, bounded in bytes by its kind and in total by a per-suite budget.

const org = 'org-a';
const run = 'sr-1';

describe('the suite-artifact evidence type', () => {
    it('is an evidence type the worker writes, not one a cell uploads with a grant', () => {
        expect(EVIDENCE_TYPES).toContain('suite-artifact');
    });

    it('has a canonical key under the organization and the suite run, one per shard, spec and file, the same every time', () => {
        const a = suiteArtifactKey({ organizationId: org, suiteRunId: run, side: 'pr', shard: 1, spec: 'cypress/e2e/cart.cy.ts', name: 'cypress/screenshots/cart.cy.ts/fail.png' });
        expect(a).toMatch(new RegExp(`^${org}/${run}/pr/[0-9a-f-]{36}/suite-artifact$`));
        expect(suiteArtifactKey({ organizationId: org, suiteRunId: run, side: 'pr', shard: 1, spec: 'cypress/e2e/cart.cy.ts', name: 'cypress/screenshots/cart.cy.ts/fail.png' })).toBe(a);
        const [o, r, side, stepId, type] = a.split('/');
        expect(evidenceKey({ organizationId: o, runId: r, side, stepId, type })).toBe(a);
        const other = (over: Partial<Parameters<typeof suiteArtifactKey>[0]>) => suiteArtifactKey({ organizationId: org, suiteRunId: run, side: 'pr', shard: 1, spec: 'cypress/e2e/cart.cy.ts', name: 'cypress/screenshots/cart.cy.ts/fail.png', ...over });
        expect(new Set([a, other({ shard: 2 }), other({ spec: 'cypress/e2e/other.cy.ts' }), other({ name: 'video.webm' })]).size).toBe(4);
    });

    it('refuses a suite run or organization id that is not a plain id', () => {
        expect(() => suiteArtifactKey({ organizationId: 'a/b', suiteRunId: run, side: 'pr', shard: 0, spec: 's', name: 'n' })).toThrow();
        expect(() => suiteArtifactKey({ organizationId: org, suiteRunId: '../x', side: 'pr', shard: 0, spec: 's', name: 'n' })).toThrow();
    });

    it('limits each kind of file by its extension: a screenshot 2 MiB, a video or trace 20 MiB, text 256 KiB, anything else refused', () => {
        const MIB = 1024 * 1024;
        expect(suiteArtifactLimit('a/fail.png')).toEqual({ contentType: 'image/png', maxBytes: 2 * MIB });
        expect(suiteArtifactLimit('a/run.webm')).toEqual({ contentType: 'video/webm', maxBytes: 20 * MIB });
        expect(suiteArtifactLimit('a/trace.zip')).toEqual({ contentType: 'application/zip', maxBytes: 20 * MIB });
        expect(suiteArtifactLimit('a/out.log')).toEqual({ contentType: 'text/plain', maxBytes: 256 * 1024 });
        expect(suiteArtifactLimit('a/dump.json')).toEqual({ contentType: 'application/json', maxBytes: 1 * MIB });
        expect(suiteArtifactLimit('a/run.mp4')).toBeUndefined();
        expect(suiteArtifactLimit('a/noext')).toBeUndefined();
    });

    it('has a per-suite budget of 200 MiB', () => {
        expect(SUITE_ARTIFACT_BUDGET_BYTES).toBe(200 * 1024 * 1024);
    });
});
