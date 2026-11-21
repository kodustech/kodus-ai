import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import { ensureRuntimeSchema } from '../../../../apps/runtime/src/shared/persistence/runtime-schema';
import { isolatedDatabase } from '../../../../apps/runtime/src/testing/isolated-database';
import type { Lesson } from '../../blockers/lessons';
import { PgLessonStore } from '../../blockers/pg-lesson.store';

import type { EnvironmentSetupRecord } from '../environment-setup';
import { PgEnvironmentSetupStore } from './pg-environment-setup.store';
import { PgSql } from './pg-sql';

// The setups and the lessons the runtime-worker writes, against a real
// Postgres (runtime.runtime_environment_setups and runtime.runtime_lessons,
// v21). Opt-in: RUNTIME_IT_DATABASE_URL, in a leased database of its own.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'setups_lessons');
const skip = !database.url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('environment setups and lessons (integration, real Postgres)', () => {
    let pool: Pool;
    let setups: PgEnvironmentSetupStore;
    let lessons: PgLessonStore;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: database.url, max: 4 });
        await ensureRuntimeSchema(pool);
        const sql = new PgSql(() => pool);
        setups = new PgEnvironmentSetupStore(sql);
        lessons = new PgLessonStore(sql);
    });
    afterAll(async () => {
        await pool?.end();
        await database.drop();
    });

    const setup = (patch: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
        environmentId: randomUUID(),
        organizationId: 'org-a',
        repositoryId: 'repo-1',
        key: `setup-${randomUUID()}`,
        state: 'setting_up',
        steps: [{ name: 'requested', state: 'done', startedAt: '2026-11-12T10:00:00.000Z' }],
        blockers: [],
        requestedAt: '2026-11-12T10:00:00.000Z',
        updatedAt: '2026-11-12T10:00:00.000Z',
        ...patch,
    });

    it("an environment keeps only its latest setup, and another org's read of it finds nothing", async () => {
        const first = setup({ expose: [{ service: 'web', port: 3000 } as never], imageId: 'img-1' });
        await setups.save(first);
        const next = setup({ environmentId: first.environmentId, state: 'active', finishedAt: '2026-11-12T10:05:00.000Z', recipe: { path: '.kodus/workspace.yaml', sha: 'c'.repeat(40), state: 'found' } });
        await setups.save(next);

        expect(await setups.get(first.environmentId)).toEqual(next);
        expect(await setups.get(first.environmentId, 'org-b')).toBeNull();
        expect(await setups.states('org-a', [first.environmentId, randomUUID()])).toEqual(new Map([[first.environmentId, 'active']]));
    });

    it("a boot's progress reaches the setup that runs it, and a late poll never writes over a finished one", async () => {
        const running = setup();
        await setups.save(running);
        const progress = { phases: [{ phase: 'build', state: 'started' as const, at: '2026-11-12T10:01:00.000Z' }], lines: ['step 1/9'], updatedAt: '2026-11-12T10:01:00.000Z' };
        await setups.saveProgress(running.environmentId, running.key, progress);
        expect((await setups.get(running.environmentId))?.progress).toEqual(progress);

        await setups.save({ ...running, state: 'active', progress: undefined });
        await setups.saveProgress(running.environmentId, running.key, { ...progress, lines: ['late'] });
        await setups.saveProgress(running.environmentId, 'another-setup', { ...progress, lines: ['other'] });
        expect((await setups.get(running.environmentId))?.progress ?? null).toBeNull();
    });

    const lesson = (patch: Partial<Lesson> = {}): Lesson => ({
        lessonId: randomUUID().replaceAll('-', ''),
        organizationId: 'org-a',
        scope: 'repo',
        repositoryId: 'repo-1',
        environmentId: 'env-1',
        signature: 'missing_env:SESSION_SECRET',
        kind: 'missing_env',
        problem: 'The app needs SESSION_SECRET',
        cause: 'The app reads an environment variable the machine did not set.',
        fix: { id: 'set_env:SESSION_SECRET', action: 'set_env' as never, summary: 'Set SESSION_SECRET in services.compose.env of the recipe.' },
        origin: { sha: 'c'.repeat(40), blockedSetupKey: 's1', fixedSetupKey: 's2', at: '2026-11-12T10:00:00.000Z' },
        helped: 1,
        state: 'active',
        firstAt: '2026-11-12T10:00:00.000Z',
        lastAt: '2026-11-12T10:00:00.000Z',
        ...patch,
    });

    it('the same lesson proven again counts once more, a retired one stays retired, and a promoted one applies across the org', async () => {
        const org = `org-${randomUUID()}`;
        const l = lesson({ organizationId: org });
        await lessons.record(l);
        await lessons.record({ ...l, lastAt: '2026-11-12T11:00:00.000Z' });
        expect(await lessons.listForRepo(org, 'repo-1')).toEqual([{ ...l, helped: 2, lastAt: '2026-11-12T11:00:00.000Z' }]);
        expect(await lessons.listForRepo(org, 'repo-2')).toEqual([]);

        expect(await lessons.update({ lessonId: l.lessonId, organizationId: org, action: 'promote', by: 'admin', at: '2026-11-12T12:00:00.000Z' })).toBe(true);
        expect((await lessons.listForRepo(org, 'repo-2')).map((x) => [x.scope, x.promotedBy])).toEqual([['org', 'admin']]);
        // Another org can neither see nor change it.
        expect(await lessons.listForRepo('org-other', 'repo-1')).toEqual([]);
        expect(await lessons.update({ lessonId: l.lessonId, organizationId: 'org-other', action: 'retire', by: 'x', at: '2026-11-12T12:00:00.000Z' })).toBe(false);

        expect(await lessons.update({ lessonId: l.lessonId, organizationId: org, action: 'retire', by: 'admin', at: '2026-11-12T13:00:00.000Z' })).toBe(true);
        await lessons.record(l);
        expect(await lessons.listForRepo(org, 'repo-1')).toEqual([]);
        expect(await lessons.listByOrganization(org)).toEqual([]);
    });

    it('the learn loop reads the lessons that helped most first', async () => {
        const org = `org-${randomUUID()}`;
        const once = lesson({ organizationId: org, lastAt: '2026-11-12T12:00:00.000Z' });
        const twice = lesson({ organizationId: org, signature: 'external_service:registry' });
        await lessons.record(once);
        await lessons.record(twice);
        await lessons.record(twice);
        expect((await lessons.listForRepo(org, 'repo-1')).map((x) => x.lessonId)).toEqual([twice.lessonId, once.lessonId]);
        // The Lessons screen: the most recent first.
        expect((await lessons.listByOrganization(org)).map((x) => x.lessonId)).toEqual([once.lessonId, twice.lessonId]);
    });
});
