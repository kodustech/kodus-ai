import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { Lesson } from '@libs/runtime/blockers/lessons';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { blockerGroups } from '../application/use-cases/environments.use-cases';
import { ListEnvironmentLessonsUseCase, UpdateEnvironmentLessonUseCase } from '../application/use-cases/lessons.use-cases';

const AT = '2026-11-04T10:00:00.000Z';
const lesson = (over: Partial<Lesson> = {}): Lesson => ({
    lessonId: 'a'.repeat(32),
    organizationId: 'org-1',
    scope: 'repo',
    repositoryId: 'repo-1',
    environmentId: 'env-1',
    signature: 'external_service:egress:api.stripe.com',
    kind: 'external_service',
    problem: "The app tried to reach api.stripe.com, which isn't allowed from the machine",
    cause: 'The app reaches an outside host at boot.',
    fix: { id: 'approve_host:api.stripe.com', action: 'approve_host', summary: 'Allowed api.stripe.com for the environment.' },
    origin: { sha: 'f'.repeat(40), branch: 'main', blockedSetupKey: 's1', fixedSetupKey: 's2', at: AT },
    helped: 2,
    state: 'active',
    firstAt: AT,
    lastAt: AT,
    ...over,
});

const setup: EnvironmentSetupRecord = {
    environmentId: 'env-1',
    organizationId: 'org-1',
    repositoryId: 'repo-1',
    key: 'k',
    state: 'blocked',
    steps: [],
    blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', at: AT }],
    failureBundle: {
        services: [],
        ports: [],
        disk: [],
        deniedEgress: [
            { host: 'cdn.example.com', port: 443, at: AT },
            { host: 'api.stripe.com', port: 443, at: AT },
        ],
        redactions: 0,
        truncated: false,
        collectedAt: AT,
    },
    requestedAt: AT,
    updatedAt: AT,
};

describe('blockerGroups with lessons', () => {
    it('puts the fix that worked before first, and says where it was learned', () => {
        // The catalog groups by the first denied host; this lesson is for that group's signature.
        const l = lesson({
            signature: 'external_service:egress:cdn.example.com',
            fix: { id: 'approve_host:api.stripe.com', action: 'approve_host', summary: 'x' },
        });
        const [g] = blockerGroups(setup, [], { lessons: [l], organizationId: 'org-1', repositoryId: 'repo-1' });
        expect(g.fixes[0]).toMatchObject({ id: 'approve_host:api.stripe.com', learned: { lessonId: l.lessonId, scope: 'repo', helped: 2 } });
        expect(g.fixes[1]).toMatchObject({ id: 'approve_host:cdn.example.com' });
        expect(g.fixes[1]).not.toHaveProperty('learned');
    });

    it("ignores another repo's lesson until it is promoted, and another org's always", () => {
        const l = lesson({
            signature: 'external_service:egress:cdn.example.com',
            fix: { id: 'approve_host:api.stripe.com', action: 'approve_host', summary: 'x' },
        });
        const q = { organizationId: 'org-1', repositoryId: 'repo-2' };
        expect(blockerGroups(setup, [], { lessons: [l], ...q })[0].fixes[0]).not.toHaveProperty('learned');
        expect(blockerGroups(setup, [], { lessons: [{ ...l, scope: 'org' }], ...q })[0].fixes[0]).toMatchObject({ learned: { scope: 'org' } });
        expect(blockerGroups(setup, [], { lessons: [{ ...l, scope: 'org', organizationId: 'org-2' }], ...q })[0].fixes[0]).not.toHaveProperty('learned');
    });
});

describe('lessons use cases', () => {
    const user = { uuid: 'u-1', email: 'admin@acme.test', organization: { uuid: 'org-1' } };
    const make = (lessons: Lesson[], deny = false) => {
        const environment = {
            load: jest.fn(async (_u: unknown, id: string) => {
                if (id !== 'env-1') throw new NotFoundException();
                return { env: { environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'repo-1' }, runs: [] };
            }),
        };
        const list = new ListEnvironmentLessonsUseCase(environment as any, { listByOrganization: async () => lessons });
        const outbox = { create: jest.fn().mockResolvedValue(undefined) };
        const authorization = {
            ensure: jest.fn(async () => {
                if (deny) throw new ForbiddenException();
            }),
        };
        const update = new UpdateEnvironmentLessonUseCase(list, authorization as any, outbox as any, () => new Date(AT));
        return { list, update, outbox, authorization };
    };

    it("lists the repo's own lessons and the org's, never another repo's or a retired one", async () => {
        const t = make([
            lesson(),
            lesson({ lessonId: 'b'.repeat(32), repositoryId: 'repo-2' }),
            lesson({ lessonId: 'c'.repeat(32), repositoryId: 'repo-2', scope: 'org' }),
            lesson({ lessonId: 'd'.repeat(32), state: 'retired' }),
        ]);
        const out = await t.list.execute({ user, environmentId: 'env-1' });
        expect(out.map((l) => l.lessonId)).toEqual(['a'.repeat(32), 'c'.repeat(32)]);
        expect(out[0]).toMatchObject({
            problem: expect.any(String),
            fix: { summary: 'Allowed api.stripe.com for the environment.' },
            origin: { sha: 'f'.repeat(40), repositoryId: 'repo-1' },
        });
    });

    it('sends the promotion to the worker through the outbox, for an org admin only', async () => {
        const t = make([lesson()]);
        await expect(t.update.execute({ user, environmentId: 'env-1', lessonId: 'a'.repeat(32), action: 'promote' })).resolves.toMatchObject({
            action: 'promote',
        });
        expect(t.authorization.ensure).toHaveBeenCalledWith(expect.objectContaining({ action: 'manage' }));
        const row = t.outbox.create.mock.calls[0][0];
        expect(row.payload.event_name ?? row.payload.eventName ?? JSON.stringify(row.payload)).toContain('runtime.lesson.update_requested');
        expect(JSON.stringify(row.payload)).toContain('"action":"promote"');

        await expect(
            make([lesson()], true).update.execute({ user, environmentId: 'env-1', lessonId: 'a'.repeat(32), action: 'retire' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(t.update.execute({ user, environmentId: 'env-1', lessonId: 'e'.repeat(32), action: 'retire' })).rejects.toBeInstanceOf(NotFoundException);
    });
});
