import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../testing/isolated-database';
import { PgSuiteSelectionState, PgSuiteShadows, type ShadowRequest } from './pg-suite-shadows';

const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'suite_shadows');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

const shadow = (n: number, over: Partial<ShadowRequest> = {}): ShadowRequest => ({
    shadowRunId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    organizationId: 'org-a',
    environmentId: 'env-1',
    repositoryId: 'repo-1',
    sourceRunId: `src-${n}`,
    prNumber: 7,
    prSha: 'a'.repeat(40),
    mergeBase: 'b'.repeat(40),
    mainSha: 'b'.repeat(40),
    selected: ['a.cy.ts'],
    changedFiles: ['src/x.ts'],
    removedFiles: ['cypress/e2e/old.cy.ts'],
    ...over,
});
const at = (min: number) => new Date(Date.parse('2026-11-23T12:00:00Z') + min * 60_000);

(skip ? describe.skip : describe)('the shadow check tables (real Postgres)', () => {
    let pool: Pool;
    let shadows: PgSuiteShadows;
    let state: PgSuiteSelectionState;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 4 });
        await ensureRuntimeSchema(pool);
        shadows = new PgSuiteShadows(pool);
        state = new PgSuiteSelectionState(pool);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });
    beforeEach(async () => {
        for (const t of ['runtime_suite_shadows', 'runtime_suite_selection_state']) await pool.query(`DELETE FROM runtime.${t}`);
    });

    describe('the requests', () => {
        it('one shadow per source run: asking twice finds the first, and another organization never reads it', async () => {
            expect(await shadows.request(shadow(1))).toEqual({ created: true });
            expect(await shadows.request(shadow(1, { shadowRunId: '00000000-0000-4000-8000-0000000000ff' }))).toEqual({ created: false });
            expect(await shadows.get('org-a', shadow(1).shadowRunId)).toMatchObject({ sourceRunId: 'src-1', prNumber: 7, selected: ['a.cy.ts'], changedFiles: ['src/x.ts'], removedFiles: ['cypress/e2e/old.cy.ts'], state: 'queued' });
            expect(await shadows.get('org-b', shadow(1).shadowRunId)).toBeNull();
        });

        it('the queued ones are listed oldest first for the product to issue, and one that started is not', async () => {
            await shadows.request(shadow(1));
            await shadows.request(shadow(2));
            expect((await shadows.pending(10)).map((p) => p.sourceRunId)).toEqual(['src-1', 'src-2']);
            await shadows.markStarted('org-a', shadow(1).shadowRunId);
            expect((await shadows.pending(10)).map((p) => p.sourceRunId)).toEqual(['src-2']);
        });
    });

    describe('the completion', () => {
        it('stores the misses once: the first completion stays and says it was the first', async () => {
            await shadows.request(shadow(1));
            expect(await shadows.complete('org-a', shadow(1).shadowRunId, { misses: ['b.cy.ts'], conclusive: true }, at(1))).toEqual({ first: true });
            expect(await shadows.complete('org-a', shadow(1).shadowRunId, { misses: [], conclusive: true }, at(2))).toEqual({ first: false });
            expect(await shadows.get('org-a', shadow(1).shadowRunId)).toMatchObject({ state: 'done', misses: ['b.cy.ts'], conclusive: true });
            // Another organization completes nothing.
            await shadows.request(shadow(2));
            expect(await shadows.complete('org-b', shadow(2).shadowRunId, { misses: ['x'], conclusive: true }, at(1))).toEqual({ first: false });
        });

        it('counts the misses among the last ten conclusive shadows of the environment, and no others', async () => {
            // 12 shadows; the oldest two missed, then two more later, one inconclusive with a miss, one of another environment.
            for (let n = 1; n <= 12; n++) {
                await shadows.request(shadow(n));
                await shadows.complete('org-a', shadow(n).shadowRunId, { misses: n <= 2 || n === 11 ? ['m.cy.ts'] : [], conclusive: true }, at(n));
            }
            await shadows.request(shadow(13));
            await shadows.complete('org-a', shadow(13).shadowRunId, { misses: ['z.cy.ts'], conclusive: false }, at(13));
            await shadows.request(shadow(14, { environmentId: 'env-2' }));
            await shadows.complete('org-a', shadow(14).shadowRunId, { misses: ['q.cy.ts'], conclusive: true }, at(14));
            // The last ten conclusive of env-1 are 3..12: only 11 missed.
            expect(await shadows.recentMisses('org-a', 'env-1', 10)).toBe(1);
            expect(await shadows.recentMisses('org-a', 'env-2', 10)).toBe(1);
        });

        it('a miss counts per spec, so a shadow that found two broken specs the selection skipped counts two', async () => {
            await shadows.request(shadow(1));
            await shadows.complete('org-a', shadow(1).shadowRunId, { misses: ['a.cy.ts', 'b.cy.ts'], conclusive: true }, at(1));
            expect(await shadows.recentMisses('org-a', 'env-1', 10)).toBe(2);
        });

        it('only the shadows finished after the selection was turned on again count', async () => {
            await shadows.request(shadow(1));
            await shadows.complete('org-a', shadow(1).shadowRunId, { misses: ['a.cy.ts'], conclusive: true }, at(1));
            expect(await shadows.recentMisses('org-a', 'env-1', 10, at(2))).toBe(0);
            expect(await shadows.recentMisses('org-a', 'env-1', 10, at(0))).toBe(1);
        });
    });

    describe('the environment\'s selection state', () => {
        it('reads as selection on with no brake for an environment that was never counted', async () => {
            expect(await state.read('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 0 });
        });

        it('counts the selected runs atomically: concurrent plans never share a number', async () => {
            const counts = await Promise.all(Array.from({ length: 8 }, () => state.recordSelected('org-a', 'env-1')));
            expect(counts.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
            expect(await state.recordSelected('org-a', 'env-2')).toBe(1);
        });

        it('a miss sets the whole suite for the next pull requests and each pull request takes one, never below zero', async () => {
            await state.applyMiss('org-a', 'env-1', { fullPrs: 2, off: false });
            expect(await state.read('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 2 });
            await state.consumeFullPr('org-a', 'env-1');
            await state.consumeFullPr('org-a', 'env-1');
            await state.consumeFullPr('org-a', 'env-1');
            expect(await state.read('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 0 });
        });

        it('off stays off through a later miss that does not ask for it, until a person turns selection on, which also starts the window afresh', async () => {
            await state.applyMiss('org-a', 'env-1', { fullPrs: 10, off: true });
            await state.applyMiss('org-a', 'env-1', { fullPrs: 10, off: false });
            expect((await state.read('org-a', 'env-1')).off).toBe(true);
            const since = await state.reenable('org-a', 'env-1', at(5));
            expect(since).toEqual(at(5));
            expect(await state.read('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 0, reenabledAt: at(5) });
        });

        it('says who turned selection off: the shadow check (a brake) or a person, and turning it on clears either', async () => {
            await state.applyMiss('org-a', 'env-1', { fullPrs: 10, off: true });
            expect(await state.read('org-a', 'env-1')).toMatchObject({ off: true, offBy: 'brake' });
            await state.reenable('org-a', 'env-1', at(1));
            await state.turnOff('org-a', 'env-2', at(2));
            expect(await state.read('org-a', 'env-2')).toMatchObject({ off: true, offBy: 'person' });
            expect(await state.read('org-a', 'env-1')).toEqual({ off: false, fullPrsLeft: 0, reenabledAt: at(1) });
            await state.reenable('org-a', 'env-2', at(3));
            expect(await state.read('org-a', 'env-2')).toEqual({ off: false, fullPrsLeft: 0, reenabledAt: at(3) });
        });

        it('a person turning selection off never takes over a brake that is already on, and never touches another organization\'s environment', async () => {
            await state.applyMiss('org-a', 'env-1', { fullPrs: 10, off: true });
            await state.turnOff('org-a', 'env-1', at(2));
            expect(await state.read('org-a', 'env-1')).toMatchObject({ off: true, offBy: 'brake' });
            await state.turnOff('org-b', 'env-1', at(3));
            expect(await state.read('org-b', 'env-1')).toEqual({ off: false, fullPrsLeft: 0 });
        });

        it('never reads or changes another organization\'s environment', async () => {
            await state.applyMiss('org-a', 'env-1', { fullPrs: 10, off: true });
            expect(await state.read('org-b', 'env-1')).toEqual({ off: false, fullPrsLeft: 0 });
            await state.reenable('org-b', 'env-1', at(1));
            expect((await state.read('org-a', 'env-1')).off).toBe(true);
        });
    });
});
