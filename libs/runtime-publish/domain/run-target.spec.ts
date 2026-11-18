import { randomUUID } from 'crypto';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { sealSecret, type RuntimeRunRequested } from '@libs/runtime/run';

import { RunTargetConflictError, runTargetOf, sameRunTarget, type RunTarget } from './run-target';
import { InMemoryRunTargetStore } from '../testing';

const target = (patch: Partial<RunTarget> = {}): RunTarget => ({
    runId: randomUUID(),
    attempt: 1,
    organizationId: 'org-a',
    teamId: 'team-a',
    repositoryId: '42',
    repositoryName: 'shop',
    platform: PlatformType.GITHUB,
    pullRequestNumber: 7,
    headSha: 'a'.repeat(40),
    ...patch,
});

// The in-memory store keeps the semantics of the Pg and TypeORM ones (their integration specs).
describe('InMemoryRunTargetStore', () => {
    it('never lets another org take over a Run that already has a target', async () => {
        const store = new InMemoryRunTargetStore();
        const t = target();
        await store.record(t);
        await expect(store.record({ ...t, organizationId: 'org-b' })).rejects.toBeInstanceOf(RunTargetConflictError);
        expect(await store.get(t.runId)).toEqual(t);
    });

    it('a read scoped to another org finds nothing', async () => {
        const store = new InMemoryRunTargetStore();
        const t = target();
        await store.record(t);
        expect(await store.get(t.runId, { organizationId: 'org-a' })).toEqual(t);
        expect(await store.get(t.runId, { organizationId: 'org-b' })).toBeNull();
    });
});

describe('the workspace of a Run target', () => {
    const runId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
    const key = Buffer.alloc(32, 7);
    const request = (patch: Partial<RuntimeRunRequested> = {}): RuntimeRunRequested => ({
        runId,
        attempt: 1,
        correlationId: 'c',
        requestedAt: '2026-10-29T12:00:00.000Z',
        organizationId: 'org-a',
        teamId: 'team-a',
        repository: { id: '42', name: 'shop', fullName: 'acme/shop' },
        pullRequest: { number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), fork: false },
        environment: { environmentId: 'e', imageId: 'i', expose: [] },
        diff: [],
        repoToken: sealSecret('ghs_x', key, runId),
        runToken: sealSecret('krt1.x.y', key, runId),
        trigger: 'pull_request',
        ...patch,
    });

    it('a one-repository request makes the target it always made, with no workspace', () => {
        const t = runTargetOf(request(), PlatformType.GITHUB);
        expect(t).not.toHaveProperty('workspace');
        expect(Object.keys(t)).toEqual(['runId', 'attempt', 'organizationId', 'teamId', 'repositoryId', 'repositoryName', 'repositoryFullName', 'platform', 'pullRequestNumber', 'headSha', 'fork']);
    });

    it('records the pinned commits of every repository, never a token or a name', () => {
        const t = runTargetOf(
            request({
                workspace: [
                    { repositoryId: '42', fullName: 'acme/shop', alias: 'shop', role: 'primary', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), source: 'pull_request' },
                    {
                        repositoryId: '43',
                        fullName: 'acme/billing',
                        alias: 'billing',
                        role: 'member',
                        baseSha: 'c'.repeat(40),
                        headSha: 'c'.repeat(40),
                        source: 'default_branch',
                        sealedRepoToken: sealSecret('ghs_y', key, runId),
                    },
                    { repositoryId: '44', fullName: 'acme/web', alias: 'web', role: 'member', baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), source: 'paired', pairedPrNumber: 9 },
                ],
            }),
            PlatformType.GITHUB,
        );
        expect(t.workspace).toEqual([
            { repositoryId: '42', alias: 'shop', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), source: 'pull_request' },
            { repositoryId: '43', alias: 'billing', baseSha: 'c'.repeat(40), headSha: 'c'.repeat(40), source: 'default_branch' },
            { repositoryId: '44', alias: 'web', baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), source: 'paired', pairedPrNumber: 9 },
        ]);
    });

    it('another workspace is another target; key order and an empty list are not', async () => {
        const ref = { repositoryId: '43', alias: 'billing', baseSha: 'c'.repeat(40), headSha: 'c'.repeat(40), source: 'default_branch' as const };
        const t = target({ workspace: [ref] });
        const reordered = { ...t, workspace: [{ source: ref.source, headSha: ref.headSha, baseSha: ref.baseSha, alias: ref.alias, repositoryId: ref.repositoryId }] };
        expect(sameRunTarget(t, reordered)).toBe(true);
        expect(sameRunTarget(target({ runId: t.runId }), { ...target({ runId: t.runId }), workspace: [] })).toBe(true);
        const store = new InMemoryRunTargetStore();
        await store.record(t);
        await expect(store.record({ ...t, workspace: [{ ...ref, headSha: 'd'.repeat(40), baseSha: 'd'.repeat(40) }] })).rejects.toBeInstanceOf(RunTargetConflictError);
        await expect(store.record({ ...t, workspace: undefined })).rejects.toBeInstanceOf(RunTargetConflictError);
        expect(await store.get(t.runId)).toEqual(t);
    });
});
