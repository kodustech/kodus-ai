import { deriveLessons } from '@libs/runtime/blockers/lessons';

import { InMemoryLessonStore } from '../setup/lesson.store';
import { LessonUpdateRequestedHandler } from './command-handlers';

const AT = '2026-11-04T10:00:00.000Z';
const [LESSON] = deriveLessons({
    previous: {
        environmentId: 'env-1',
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        key: 's1',
        state: 'blocked',
        steps: [],
        blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'x', at: AT }],
        failureBundle: {
            services: [],
            ports: [],
            disk: [],
            deniedEgress: [{ host: 'api.stripe.com', port: 443, at: AT }],
            redactions: 0,
            truncated: false,
            collectedAt: AT,
        },
        requestedAt: AT,
        updatedAt: AT,
    },
    current: {
        environmentId: 'env-1',
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        key: 's2',
        state: 'active',
        steps: [],
        blockers: [],
        refSource: 'default_branch',
        sha: 'f'.repeat(40),
        requestedAt: AT,
        updatedAt: AT,
    },
    approvedHosts: ['api.stripe.com'],
    at: AT,
});
const cmd = (over: Record<string, unknown> = {}) => ({
    lessonId: LESSON.lessonId,
    organizationId: 'org-1',
    action: 'promote',
    requestedBy: { userId: 'admin-1' },
    requestedAt: AT,
    ...over,
});

describe('LessonUpdateRequestedHandler', () => {
    it('promotes and retires a lesson of that org only', async () => {
        const store = new InMemoryLessonStore();
        await store.record(LESSON);
        const handler = new LessonUpdateRequestedHandler(store);
        await handler.handle(cmd({ organizationId: 'org-2' }));
        expect(store.byId.get(LESSON.lessonId)).toMatchObject({ scope: 'repo' });
        await handler.handle(cmd());
        expect(store.byId.get(LESSON.lessonId)).toMatchObject({ scope: 'org', promotedBy: 'admin-1' });
        await handler.handle(cmd({ action: 'retire' }));
        expect(store.byId.get(LESSON.lessonId)).toMatchObject({ state: 'retired', retiredBy: 'admin-1' });
    });

    it('refuses a malformed command', async () => {
        await expect(new LessonUpdateRequestedHandler(new InMemoryLessonStore()).handle(cmd({ action: 'delete' }))).resolves.toMatchObject({
            invalid: 'invalid lesson update',
        });
    });

    it('a lesson proven again counts once more, and a retired one stays retired', async () => {
        const store = new InMemoryLessonStore();
        await store.record(LESSON);
        await store.record({ ...LESSON, lastAt: '2026-11-05T10:00:00.000Z' });
        expect(store.byId.get(LESSON.lessonId)).toMatchObject({ helped: 2, lastAt: '2026-11-05T10:00:00.000Z' });
        await store.update({ lessonId: LESSON.lessonId, organizationId: 'org-1', action: 'retire', by: 'a', at: AT });
        await store.record(LESSON);
        expect(store.byId.get(LESSON.lessonId)).toMatchObject({ state: 'retired' });
    });
});
