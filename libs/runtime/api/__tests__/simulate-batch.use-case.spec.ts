import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/domain/run-target';
import { RuntimeRunRequestBuilder } from '@libs/runtime/api/application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '@libs/runtime/api/application/runtime-run-enqueuer.service';
import { SimulateRuntimeRunUseCase } from '@libs/runtime/api/application/use-cases/simulate.use-case';
import type { ProductEnvironment, PullRequestHead, RuntimeGitPort } from '@libs/runtime/api/domain/ports';
import { BASE_SHA, clock, config, FakeOutbox, NOW, ORG, REPO, realAuthorization, run, SECRET, SHA, storeWith, TEAM, user } from '@libs/runtime/api/__tests__/fixtures';

const env: ProductEnvironment = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
const defaultHead: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'merged' };
async function fixture(headFor: (prNumber: number) => PullRequestHead | null = () => defaultHead, live: ReturnType<typeof run>[] = [], failedDiffPr?: number) {
    const heads: number[] = [];
    const mint = jest.fn(async () => 'fixture-repository-token');
    const git = {
        getPullRequestHead: async ({ prNumber }: { prNumber: number }) => { heads.push(prNumber); return headFor(prNumber); },
        getPullRequestDiff: async ({ prNumber }: { prNumber: number }) => {
            if (prNumber === failedDiffPr) throw new Error('fixture-diff-unavailable');
            return { files: [{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], truncated: false };
        },
    } as unknown as RuntimeGitPort;
    const outbox = new FakeOutbox();
    const targets = new InMemoryRunTargetStore();
    const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
    const useCase = new SimulateRuntimeRunUseCase(
        { get: async (org: string, id: string) => org === ORG && id === env.environmentId ? env : null } as any,
        realAuthorization([REPO]), await storeWith(...live), git,
        new RuntimeRunRequestBuilder(git, { issue: mint }, { get: async () => ({ environmentId: env.environmentId, organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: 'img-1', expose: [] }) }, config({ runTokenSecret: SECRET }), clock), enqueuer,
    );
    return { useCase, mint, outbox, targets, heads };
}
const request = (body: unknown, role = Role.OWNER) => ({ user: user(role), environmentId: 'env-1', body });

describe('HTML §7 bounded past-PR simulation batch', () => {
    it('queues at most five selected historical PRs in request order without publication targets', async () => {
        const f = await fixture();
        const out = await f.useCase.execute(request({ prNumbers: [482, 483, 484, 485, 486] })) as any;
        expect(out.runs).toHaveLength(5);
        expect(out.runs.map((r: any) => r.prNumber)).toEqual([482, 483, 484, 485, 486]);
        expect(out.runs.every((r: any) => r.state === 'queued')).toBe(true);
        expect(f.outbox.rows).toHaveLength(5);
        for (const r of out.runs) expect(await f.targets.get(r.runId)).toBeNull();
    });

    it('preflights a fork late in the batch before any token mint or outbox side effect', async () => {
        const f = await fixture((n) => ({ ...defaultHead, fork: n === 484 }));
        await expect(f.useCase.execute(request({ prNumbers: [482, 483, 484] }))).rejects.toBeInstanceOf(ConflictException);
        expect(f.heads).toEqual([482, 483, 484]);
        expect(f.mint).not.toHaveBeenCalled();
        expect(f.outbox.rows).toHaveLength(0);
    });

    it('preflights a live same-head Run late in the batch before any token mint or outbox side effect', async () => {
        const f = await fixture(undefined, [run({ prNumber: 484, state: 'testing' })]);
        await expect(f.useCase.execute(request({ prNumbers: [482, 483, 484] }))).rejects.toBeInstanceOf(ConflictException);
        expect(f.heads).toEqual([482, 483, 484]);
        expect(f.mint).not.toHaveBeenCalled();
        expect(f.outbox.rows).toHaveLength(0);
    });

    it('checks authorization before consulting any selected PR or minting tokens', async () => {
        const f = await fixture();
        await expect(f.useCase.execute(request({ prNumbers: [482, 483] }, Role.CONTRIBUTOR))).rejects.toBeInstanceOf(ForbiddenException);
        expect(f.heads).toEqual([]);
        expect(f.mint).not.toHaveBeenCalled();
        expect(f.outbox.rows).toHaveLength(0);
    });

    it('refuses a missing PR late in the batch before minting tokens', async () => {
        const f = await fixture((number) => number === 484 ? null : defaultHead);
        await expect(f.useCase.execute(request({ prNumbers: [482, 483, 484] }))).rejects.toBeInstanceOf(NotFoundException);
        expect(f.heads).toEqual([482, 483, 484]);
        expect(f.mint).not.toHaveBeenCalled();
        expect(f.outbox.rows).toHaveLength(0);
    });

    it('a later request preparation failure cannot enqueue earlier prepared Runs', async () => {
        const f = await fixture(undefined, [], 484);
        await expect(f.useCase.execute(request({ prNumbers: [482, 483, 484] }))).rejects.toThrow('fixture-diff-unavailable');
        expect(f.heads).toEqual([482, 483, 484]);
        // Token issuance is outside the database transaction, but no Run has been enqueued.
        expect(f.mint).toHaveBeenCalledTimes(4);
        expect(f.outbox.rows).toHaveLength(0);
    });

    it.each([[], [1, 2, 3, 4, 5, 6], [1, 1], [0], [1.5], ['1']].map((prNumbers) => ({ prNumbers })))('refuses invalid bounded unique PR list $prNumbers', async ({ prNumbers }) => {
        const f = await fixture();
        await expect(f.useCase.execute(request({ prNumbers }))).rejects.toBeInstanceOf(BadRequestException);
        expect(f.heads).toEqual([]);
        expect(f.mint).not.toHaveBeenCalled();
        expect(f.outbox.rows).toHaveLength(0);
    });

    it('retains the existing single-PR request and response shape', async () => {
        const f = await fixture();
        const out = await f.useCase.execute({ ...request({}), body: { prNumber: 482 } });
        expect(out).toMatchObject({ runId: expect.any(String), state: 'queued' });
        expect(f.outbox.rows).toHaveLength(1);
        expect(await f.targets.get(out.runId)).toBeNull();
    });

    it('validates every prepared Run before the atomic writer can see any message', async () => {
        const f = await fixture();
        await f.useCase.execute({ ...request({}), body: { prNumber: 482 } });
        const { workflowType: _route, ...sample } = (f.outbox.rows[0] as any).payload.payload;
        const outbox = { create: jest.fn(), createBatch: jest.fn() };
        const targets = { record: jest.fn(), get: jest.fn() };
        const enqueuer = new RuntimeRunEnqueuer(targets, outbox, { getTypeIntegration: async () => PlatformType.GITHUB });
        const next = { ...sample, runId: randomUUID(), pullRequest: { ...sample.pullRequest, number: 483 } };

        for (const batch of [
            [], Array(6).fill(sample), [sample, sample],
            [sample, { ...next, trigger: 'pull_request' }],
            [sample, { ...next, organizationId: 'another-org' }],
            [sample, { ...next, teamId: 'another-team' }],
            [sample, { ...next, repository: { ...sample.repository, id: 'another-repo' } }],
            [sample, { ...next, environment: { ...sample.environment, environmentId: 'another-env' } }],
            [sample, { ...next, runId: sample.runId }],
            [sample, { ...next, pullRequest: { ...next.pullRequest, headSha: 'not-a-sha' } }],
        ]) {
            await expect(enqueuer.enqueueSimulations(batch as any)).rejects.toThrow();
        }
        expect(outbox.createBatch).not.toHaveBeenCalled();
        expect(outbox.create).not.toHaveBeenCalled();
        expect(targets.record).not.toHaveBeenCalled();
    });
});
