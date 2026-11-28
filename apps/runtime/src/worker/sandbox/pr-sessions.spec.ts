import { randomUUID } from 'crypto';

import { sessionRef } from '../../shared/persistence/snapshot-placements';
import { RunCancelRequestedHandler } from '../commands/run-requested.handler';
import { PullRequestSessions } from './pr-sessions';
import { SandboxService, type SandboxHub } from './sandbox.service';
import { InMemorySnapshotPlacements } from '../../shared/persistence/testing';

const pr = { repositoryId: 'repo-1', prNumber: 7 };
const id = (n: number) => `ksn-${String(n).padStart(32, '0')}`;

describe('the sessions of a closed or merged PR', () => {
    it('are removed from every cell that holds one; a cell that refused or is not connected keeps them for the sweep', async () => {
        const placements = new InMemorySnapshotPlacements();
        await placements.record('org-a', sessionRef(id(1)), 'cell-a', pr);
        await placements.record('org-a', sessionRef(id(2)), 'cell-a', pr);
        await placements.record('org-a', sessionRef(id(3)), 'cell-b', pr);
        await placements.record('org-a', sessionRef(id(4)), 'cell-c', pr);
        await placements.record('org-a', sessionRef(id(5)), 'cell-a', { ...pr, prNumber: 8 }); // another PR
        await placements.record('org-a', sessionRef(id(6)), 'cell-a'); // a session of no PR
        const posts: Array<{ path: string; body: any }> = [];
        const hub = {
            async replicaForCell(cellId: string) {
                return cellId === 'cell-c' ? null : 'http://hub-1';
            },
            async post<T>(_url: string, path: string, body: unknown): Promise<T> {
                posts.push({ path, body });
                if (path.includes('cell-b')) throw new Error('hub /forget-sessions answered 409');
                return { status: 'forgotten' } as T;
            },
        };
        const out = await new PullRequestSessions(hub, placements).forget('org-a', pr);
        expect(out).toEqual({ forgotten: 2, kept: 2 });
        expect(posts).toEqual([
            { path: '/internal/cells/cell-a/forget-sessions', body: { organizationId: 'org-a', snapshotIds: [id(1), id(2)] } },
            { path: '/internal/cells/cell-b/forget-sessions', body: { organizationId: 'org-a', snapshotIds: [id(3)] } },
        ]);
        expect((await placements.sessionsOf('org-a', pr)).map((s) => s.snapshotId).sort()).toEqual([id(3), id(4)]);
        expect(await placements.sessionsOf('org-a', { ...pr, prNumber: 8 })).toHaveLength(1);
        expect(await placements.cellOf('org-a', sessionRef(id(6)))).toBe('cell-a');
    });

    it('go when the worker takes the PR close, with or without a live Run, and not on a superseding push', async () => {
        const forgot: unknown[] = [];
        const sessions = { forget: async (org: string, p: unknown) => void forgot.push([org, p]) };
        const handler = new RunCancelRequestedHandler(
            { stop: jest.fn() } as any,
            { findLive: async () => [] } as any,
            { withLock: async (_k: string, f: () => Promise<void>) => f() } as any,
            { cancel: async () => undefined, canCancel: async () => true } as any,
            undefined,
            sessions,
        );
        await handler.handle({ organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 7, reason: 'pr_closed' }, { messageId: randomUUID() } as any);
        await handler.handle({ organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 7, reason: 'superseded', headSha: 'a'.repeat(40) }, { messageId: randomUUID() } as any);
        expect(forgot).toEqual([['org-a', pr]]);
    });

    it("a session of a PR's sandbox is recorded with its PR; a template never is", async () => {
        const placements = new InMemorySnapshotPlacements();
        const hub: SandboxHub = {
            hubBaseUrl: 'http://hub',
            async replicaForClaim() {
                return 'http://hub-1';
            },
            async reserveCell() {
                return { cellId: 'cell-a', replicaUrl: 'http://hub-1', owner: 'kodus' } as any;
            },
            async post<T>(_u: string, _p: string, body: any): Promise<T> {
                return { id: id(9), purpose: body.purpose, ms: 3, cellId: 'cell-a' } as T;
            },
        };
        const s = new SandboxService({ hub, isStopped: async () => false, placements });
        await s.snapshot({ organizationId: 'org-a', sandboxId: randomUUID(), stepId: randomUUID(), purpose: 'session', pullRequest: pr });
        expect(await placements.sessionsOf('org-a', pr)).toEqual([{ snapshotId: id(9), cellId: 'cell-a' }]);
    });
});
