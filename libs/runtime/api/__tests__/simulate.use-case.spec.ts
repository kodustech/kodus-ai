import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { RuntimeRunRequestedSchema } from '@libs/runtime/run';

import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { SimulateRuntimeRunUseCase } from '../application/use-cases/simulate.use-case';
import type { ProductEnvironment, PullRequestHead, RuntimeGitPort } from '../domain/ports';
import { BASE_SHA, clock, config, FakeOutbox, NOW, ORG, OTHER_ORG, OTHER_REPO, REPO, realAuthorization, run, SECRET, SHA, storeWith, TEAM, user } from './fixtures';

const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...patch,
});

async function setup(head: PullRequestHead | null = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'merged' }, ...live: ReturnType<typeof run>[]) {
    const environments = {
        get: async (org: string, id: string) =>
            [env(), env({ environmentId: 'env-2', repositoryId: OTHER_REPO })].find((e) => e.organizationId === org && e.environmentId === id) ?? null,
    };
    const git = {
        getPullRequestHead: async () => head,
        getPullRequestDiff: async () => ({ files: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], truncated: false }),
    } as unknown as RuntimeGitPort;
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
    const useCase = new SimulateRuntimeRunUseCase(
        environments as any,
        realAuthorization([REPO]),
        await storeWith(...live),
        git,
        new RuntimeRunRequestBuilder(
            git,
            { issue: async () => 'repo-token' },
            { get: async () => ({ environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-1', expose: [] }) },
            config({ runTokenSecret: SECRET }),
            clock,
        ),
        enqueuer,
    );
    return { useCase, outbox, targets };
}

describe('SimulateRuntimeRunUseCase ("Try it")', () => {
    it('enqueues one simulate Run on a past PR and records no publish target, so nothing can be posted', async () => {
        const s = await setup();
        const out = await s.useCase.execute({ user: user(Role.REPO_ADMIN), environmentId: 'env-1', body: { prNumber: 482 } });
        expect(out.state).toBe('queued');
        expect(s.outbox.rows).toHaveLength(1);
        const payload = (s.outbox.rows[0] as any).payload.payload;
        const { workflowType: _w, ...msg } = payload;
        expect(RuntimeRunRequestedSchema.parse(msg)).toMatchObject({ runId: out.runId, trigger: 'simulate', pullRequest: { number: 482, headSha: SHA } });
        expect(await s.targets.get(out.runId)).toBeNull();
    });

    it('refuses forks, a live Run on the same head, another org and readers without settings access', async () => {
        const fork = await setup({ headSha: SHA, baseSha: BASE_SHA, fork: true });
        await expect(fork.useCase.execute({ user: user(Role.OWNER), environmentId: 'env-1', body: { prNumber: 1 } })).rejects.toBeInstanceOf(ConflictException);
        const busy = await setup(undefined, run({ prNumber: 482, state: 'testing' }));
        await expect(busy.useCase.execute({ user: user(Role.OWNER), environmentId: 'env-1', body: { prNumber: 482 } })).rejects.toBeInstanceOf(ConflictException);
        const s = await setup();
        await expect(s.useCase.execute({ user: user(Role.OWNER, { org: OTHER_ORG }), environmentId: 'env-1', body: { prNumber: 1 } })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.useCase.execute({ user: user(Role.CONTRIBUTOR), environmentId: 'env-1', body: { prNumber: 1 } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(s.useCase.execute({ user: user(Role.REPO_ADMIN), environmentId: 'env-2', body: { prNumber: 1 } })).rejects.toBeInstanceOf(ForbiddenException);
        const gone = await setup(null);
        await expect(gone.useCase.execute({ user: user(Role.OWNER), environmentId: 'env-1', body: { prNumber: 1 } })).rejects.toBeInstanceOf(NotFoundException);
    });
});
