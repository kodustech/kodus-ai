import { runtimeCommandHandlers } from './runtime-command-handlers';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { InMemoryPrAdmissionStore } from '../../shared/admission/testing';
import { InMemoryCommandStore, InMemoryDistributedLocks } from '../../shared/persistence/testing';
import { InMemorySuiteRuns } from '../suite/testing';
import { SuiteRetriedHandler } from './suite-retried.handler';

// docs/runtime/e2e-suites.md section 11: a person asks to run one shard of a suite again, or every spec that did not
// pass. It starts a new suite run of the same commits, limited to those specs; the product brings the tokens.

const ORIGINAL = '0b8e3c2a-6d1f-4a57-9c3e-1f2a3b4c5d6e';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

async function world(over: { finished?: boolean } = {}) {
    const runs = new InMemorySuiteRuns();
    await runs.create({ suiteRunId: ORIGINAL, organizationId: 'org-a', environmentId: 'env-shop', repositoryId: 'repo-1', mode: 'ci', prNumber: 7, prSha: B, mergeBase: A, mainSha: A, requestedAt: new Date('2026-11-23T12:00:00.000Z') });
    await runs.savePlan('org-a', ORIGINAL, [{ shard: 0, specs: ['a.cy.ts', 'b.cy.ts'] }, { shard: 1, specs: ['c.cy.ts', 'd.cy.ts'] }]);
    await runs.recordResults('org-a', ORIGINAL, { phase: 'shard', shard: 0 }, [
        { spec: 'a.cy.ts', status: 'passed', durationMs: 1, tests: [] },
        { spec: 'b.cy.ts', status: 'failed', durationMs: 1, tests: [] },
    ]);
    await runs.recordResults('org-a', ORIGINAL, { phase: 'shard', shard: 1 }, [
        { spec: 'c.cy.ts', status: 'infra', durationMs: 0, tests: [] },
        { spec: 'd.cy.ts', status: 'passed', durationMs: 1, tests: [] },
    ]);
    if (over.finished !== false) await runs.finish('org-a', ORIGINAL, 'failed', new Date('2026-11-23T12:30:00.000Z'));
    const started: any[] = [];
    const handler = new SuiteRetriedHandler(runs, { start: async (c) => (started.push(c), 'wf') });
    return { handler, started };
}
const body = (over: Record<string, unknown> = {}) => ({
    suiteRunId: ORIGINAL,
    organizationId: 'org-a',
    scope: 'failed',
    requestedBy: { userId: 'user-1' },
    requestedAt: '2026-11-23T13:00:00.000Z',
    key: 'retry-1',
    repositoryFullName: 'acme/shop',
    repoToken: 'sealed:v1:t0',
    moreRepoTokens: ['sealed:v1:t1'],
    ...over,
});

describe('SuiteRetriedHandler', () => {
    it('runs again every spec that did not pass, as a new suite run of the same commits that carries the retry tokens', async () => {
        const w = await world();
        expect(await w.handler.handle(body())).toBeUndefined();
        expect(w.started).toEqual([
            expect.objectContaining({
                organizationId: 'org-a', environmentId: 'env-shop', repositoryId: 'repo-1', repositoryFullName: 'acme/shop', mode: 'ci', prNumber: 7, prSha: B, mergeBase: A, mainSha: A,
                specs: ['b.cy.ts', 'c.cy.ts'], key: 'retry-1', repoToken: 'sealed:v1:t0', moreRepoTokens: ['sealed:v1:t1'], requestedAt: '2026-11-23T13:00:00.000Z',
            }),
        ]);
        expect(w.started[0].suiteRunId).toMatch(/^[0-9a-f-]{36}$/);
        expect(w.started[0].suiteRunId).not.toBe(ORIGINAL);
    });

    it('runs again the specs of the shard it names', async () => {
        const w = await world();
        await w.handler.handle(body({ scope: 'shard', shard: 1 }));
        expect(w.started[0].specs).toEqual(['c.cy.ts', 'd.cy.ts']);
    });

    it('the same retry key is the same new run, so a redelivery finds it', async () => {
        const w = await world();
        await w.handler.handle(body());
        await w.handler.handle(body());
        expect(w.started[0].suiteRunId).toBe(w.started[1].suiteRunId);
        await w.handler.handle(body({ key: 'retry-2' }));
        expect(w.started[2].suiteRunId).not.toBe(w.started[0].suiteRunId);
    });

    it('refuses what cannot be retried and starts nothing: another organization, a run still going, a shard it never had, nothing red, no tokens', async () => {
        const w = await world();
        const refused = [
            await w.handler.handle(body({ organizationId: 'org-b' })),
            await w.handler.handle(body({ scope: 'shard', shard: 9 })),
            await w.handler.handle(body({ repoToken: undefined, moreRepoTokens: undefined })),
            await w.handler.handle(body({ suiteRunId: '0b8e3c2a-6d1f-4a57-9c3e-1f2a3b4c5d00' })),
            await w.handler.handle({ nonsense: true }),
        ];
        for (const r of refused) expect(r).toMatchObject({ invalid: expect.any(String) });
        const running = await world({ finished: false });
        expect(await running.handler.handle(body())).toMatchObject({ invalid: expect.stringContaining('still') });
        expect([...w.started, ...running.started]).toEqual([]);
    });

    it('is a handler of the command only when the worker has an engine and the run store for it', () => {
        const base = { engine: {} as any, projection: new InMemoryRunProjectionStore(), commands: new InMemoryCommandStore(), admissions: new InMemoryPrAdmissionStore(), locks: new InMemoryDistributedLocks() };
        const has = (deps: object) => runtimeCommandHandlers({ ...base, ...deps }).some((h) => h.event === RuntimeCommandName.SuiteRetried);
        expect(has({})).toBe(false);
        expect(has({ suites: { start: async () => 'wf' } })).toBe(false);
        expect(has({ suites: { start: async () => 'wf' }, suiteRuns: new InMemorySuiteRuns() })).toBe(true);
    });
});
