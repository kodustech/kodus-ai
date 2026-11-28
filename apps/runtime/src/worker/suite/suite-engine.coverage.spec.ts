import type { RuntimeSuiteRequested } from '@libs/runtime/contracts/runtime-commands';
import { suiteDigestOf } from '@libs/runtime/suite';

import { FakeSuiteCell, FakeSuiteDemand, InMemorySuiteCoverageMaps, InMemorySuiteRuns, InMemorySuiteSpecStats, SuiteClock, type FakeSuiteWorld } from './testing';
import { type SuiteConfig, SuiteEngine, type SuiteInputs } from './suite-engine';

// docs/runtime/e2e-suites.md section 6.1 and D10 (build-plan step 10): the baseline, and only the baseline, records which
// source files each spec exercises, one spec at a time against a service, so a PR run can select by it.

const ORG = 'org-a';
const ENV = 'env-shop';
const MAIN = 'a'.repeat(40);
const config: SuiteConfig = { runner: 'cypress', command: 'fake-runner --specs "{specs}"', cwd: 'apps/dashboard', env: { BASE_URL: 'http://web' }, resultsGlob: 'results/*.xml', shardTimeoutMs: 25 * 60_000, maxShards: 1 };
const baseline: RuntimeSuiteRequested = { suiteRunId: 'sr-b', organizationId: ORG, environmentId: ENV, repositoryId: 'repo-1', mode: 'baseline', mainSha: MAIN, requestedAt: '2026-11-23T12:00:00.000Z', key: 'sr-b' };
const pr: RuntimeSuiteRequested = { ...baseline, suiteRunId: 'sr-1', mode: 'ci', prNumber: 7, prSha: 'b'.repeat(40), mergeBase: MAIN, key: 'sr-1' };

// A fixture app: two UI specs that touch different files (and one shared), and one that only calls the API.
const scenario: FakeSuiteWorld = {
    specs: {
        'cypress/e2e/cart.cy.ts': { covers: ['src/cart.ts', 'src/shared.ts'] },
        'cypress/e2e/profile.cy.ts': { covers: ['src/profile.ts', 'src/shared.ts'] },
        'cypress/e2e/orders-api.cy.ts': { covers: ['server/orders.ts', 'server/db.ts'] },
    },
};

function world(w: FakeSuiteWorld = scenario) {
    const clock = new SuiteClock();
    const cell = new FakeSuiteCell(clock, w);
    const maps = new InMemorySuiteCoverageMaps();
    const engine = new SuiteEngine({ env: cell, runs: new InMemorySuiteRuns(clock), stats: new InMemorySuiteSpecStats(), demand: new FakeSuiteDemand(clock), clock, maps });
    const specs = Object.keys(w.specs);
    const inputs = (extra: Partial<SuiteInputs> = {}): SuiteInputs => ({ config, specs: specs.map((path) => ({ path, sizeBytes: 100 })), coverage: true, ...extra });
    return { cell, maps, engine, inputs, digest: suiteDigestOf(config, specs) };
}

describe('coverage on the baseline', () => {
    it('stores per spec the files it exercised: they differ per spec, and the API-only spec has its server files', async () => {
        const w = world();
        await w.engine.run(baseline, w.inputs());
        const map = [...w.maps.rows.values()][0];
        expect(map).toMatchObject({ organizationId: ORG, environmentId: ENV, mainSha: MAIN, suiteDigest: w.digest, status: 'complete' });
        expect(map.specs).toEqual({
            'cypress/e2e/cart.cy.ts': ['src/cart.ts', 'src/shared.ts'],
            'cypress/e2e/profile.cy.ts': ['src/profile.ts', 'src/shared.ts'],
            'cypress/e2e/orders-api.cy.ts': ['server/db.ts', 'server/orders.ts'],
        });
    });

    it('runs one spec per command, each with its own coverage directory, so two specs never run against a service together', async () => {
        const w = world();
        await w.engine.run(baseline, w.inputs());
        expect(w.cell.starts.map((s) => s.specs.length)).toEqual([1, 1, 1]);
        const dirs = w.cell.starts.map((s) => s.env.NODE_V8_COVERAGE);
        expect(dirs.every((d) => typeof d === 'string' && d.startsWith('/'))).toBe(true);
        expect(new Set(dirs).size).toBe(3);
        expect(w.cell.starts.every((s) => s.env.BASE_URL === 'http://web')).toBe(true);
        expect(w.cell.maxConcurrentOnClaim).toBe(1);
    });

    it('a PR run collects no coverage: no NODE_V8_COVERAGE, one command for the shard, no coverage read, nothing stored', async () => {
        const w = world();
        await w.engine.run(pr, w.inputs());
        expect(w.cell.starts).toHaveLength(1);
        expect(w.cell.starts[0].specs).toHaveLength(3);
        expect(w.cell.starts.some((s) => 'NODE_V8_COVERAGE' in s.env)).toBe(false);
        expect(w.cell.coverageReads).toEqual([]);
        expect(w.maps.rows.size).toBe(0);
    });

    it('a baseline asked for no coverage runs the suite as one command and stores no map', async () => {
        const w = world();
        await w.engine.run(baseline, w.inputs({ coverage: false }));
        expect(w.cell.starts).toHaveLength(1);
        expect(w.maps.rows.size).toBe(0);
    });

    it('is incomplete when a spec left no dump: the files of the others are kept, and the incomplete map is no map for a PR', async () => {
        const w = world({ specs: { ...scenario.specs, 'cypress/e2e/profile.cy.ts': { noCoverage: true } } });
        await w.engine.run(baseline, w.inputs());
        const map = [...w.maps.rows.values()][0];
        expect(map.status).toBe('incomplete');
        expect(Object.keys(map.specs).sort()).toEqual(['cypress/e2e/cart.cy.ts', 'cypress/e2e/orders-api.cy.ts']);
    });

    it('is incomplete when a spec never ran', async () => {
        const w = world({ specs: { ...scenario.specs, 'cypress/e2e/profile.cy.ts': { ms: 90 * 60_000, covers: ['src/profile.ts'] } } });
        await w.engine.run(baseline, w.inputs());
        expect([...w.maps.rows.values()][0].status).toBe('incomplete');
    });

    it('a red spec on main keeps what it exercised before it failed', async () => {
        const w = world({ specs: { ...scenario.specs, 'cypress/e2e/cart.cy.ts': { covers: ['src/cart.ts'], main: [{ fail: 'boom' }] } } });
        await w.engine.run(baseline, w.inputs());
        const map = [...w.maps.rows.values()][0];
        expect(map.status).toBe('complete');
        expect(map.specs['cypress/e2e/cart.cy.ts']).toEqual(['src/cart.ts']);
    });
});
