import type { Blocked, Claim } from '@libs/runtime/environment';
import type { Envelope, LayerBuild } from '@libs/runtime/protocol';

import { claimIdFor } from '../../shared/claim-id';
import { BUILD_CAPACITY_RETRIES, BUILD_CAPACITY_RETRY_MS, BUILD_FAILURE_MEMORY_MS, BUILD_REPORT_CEILING_MS, type BuilderAcquire, ToolLayerBuilds } from './tool-layers';

// The builder queue of the hub (docs/runtime/persistent-state.md 4.5): single-flight per (org, cell, key), one
// builder per cell and two per org, failures remembered for 10 minutes, a builder that waits for room behind reviews.

const key = (c: string) => c.repeat(64);
const layer = (k: string, id = 'some-cli'): LayerBuild => ({ key: key(k), id, installer: 'npm', argv: ['npm', 'install', '-g', 'some-cli@1.2.3'], binary: 'some-cli', registry: 'registry.npmjs.org' });
const ready = { claimId: 'x' } as unknown as Claim;
const noCapacity: Blocked = { status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'no room' }] };

function setup(answer: (cellId: string, req: BuilderAcquire) => Claim | Blocked | Promise<Claim | Blocked> = () => ready) {
    jest.useFakeTimers();
    let nowMs = Date.parse('2026-11-22T10:00:00Z');
    const opened: Array<{ cellId: string; claimId: string; req: BuilderAcquire }> = [];
    const released: string[] = [];
    const logs: string[] = [];
    const builds = new ToolLayerBuilds(
        async (cellId, req) => {
            opened.push({ cellId, claimId: claimIdFor(req.organizationId, req.idempotencyKey), req });
            return answer(cellId, req);
        },
        async (ref) => void released.push(ref.claimId),
        (_l, msg) => void logs.push(msg),
        () => new Date(nowMs),
    );
    const settle = async () => {
        for (let i = 0; i < 6; i++) await Promise.resolve();
    };
    const result = (cellId: string, claimId: string, body: object, type: 'toollayer.built' | 'toollayer.failed' = 'toollayer.built') =>
        builds.onResult({ cred: { cellId, owner: 'kodus' } }, { type, claimId, body } as unknown as Envelope<'toollayer.built'>);
    const built = (cellId: string, claimId: string, l: LayerBuild) => result(cellId, claimId, { key: l.key, id: l.id, digest: key('d'), bytes: 10 });
    const failed = (cellId: string, claimId: string, l: LayerBuild, reason = 'install_exit') => result(cellId, claimId, { key: l.key, id: l.id, reason }, 'toollayer.failed');
    return { builds, opened, released, logs, settle, built, failed, result, advance: (ms: number) => { nowMs += ms; jest.advanceTimersByTime(ms); } };
}

afterEach(() => jest.useRealTimers());

describe('ToolLayerBuilds', () => {
    it('opens one builder for the layer on the cell that asked, with only the plan', async () => {
        const t = setup();
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('queued');
        await t.settle();
        expect(t.opened).toHaveLength(1);
        expect(t.opened[0]).toMatchObject({ cellId: 'cell-1', req: { organizationId: 'org-a', sandboxLayerBuild: layer('a') } });
        expect(Object.keys(t.opened[0].req).sort()).toEqual(['idempotencyKey', 'organizationId', 'sandboxLayerBuild']);
    });

    it('is single-flight per org, cell and key: a second ask while it runs opens nothing, another cell or org is its own build', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('duplicate');
        await t.settle();
        expect(t.opened).toHaveLength(1);
        t.builds.request('org-a', 'cell-2', layer('a'));
        t.builds.request('org-b', 'cell-3', layer('a'));
        await t.settle();
        expect(t.opened.map((o) => o.cellId).sort()).toEqual(['cell-1', 'cell-2', 'cell-3']);
    });

    it('runs one builder at a time per cell, and the next starts when the first reports', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        t.builds.request('org-a', 'cell-1', layer('b', 'other-cli'));
        await t.settle();
        expect(t.opened).toHaveLength(1);
        expect(t.built('cell-1', t.opened[0].claimId, layer('a'))).toBe('recorded');
        await t.settle();
        expect(t.opened).toHaveLength(2);
        expect(t.opened[1].req.sandboxLayerBuild.key).toBe(key('b'));
    });

    it('runs two builders at a time per org across cells, the third waits', async () => {
        const t = setup();
        for (const [i, c] of ['a', 'b', 'c'].entries()) t.builds.request('org-a', `cell-${i}`, layer(c, `cli-${c}`));
        t.builds.request('org-b', 'cell-9', layer('d', 'cli-d'));
        await t.settle();
        // org-a opened two (cell-0, cell-1); org-b's own build is not held up by org-a's cap.
        expect(t.opened.map((o) => o.cellId).sort()).toEqual(['cell-0', 'cell-1', 'cell-9']);
        t.built('cell-0', t.opened.find((o) => o.cellId === 'cell-0')!.claimId, layer('a', 'cli-a'));
        await t.settle();
        expect(t.opened.map((o) => o.cellId)).toContain('cell-2');
    });

    it('releases the builder claim after its result and leaves nothing pending', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        t.built('cell-1', t.opened[0].claimId, layer('a'));
        expect(t.released).toEqual([t.opened[0].claimId]);
        expect(t.builds.pending()).toBe(0);
    });

    it('tolerates a release that fails (the cell ended the builder itself, so it answers unknown_claim): the next build still starts', async () => {
        jest.useFakeTimers();
        const opened: Array<{ cellId: string; claimId: string }> = [];
        const builds = new ToolLayerBuilds(
            async (cellId, req) => {
                opened.push({ cellId, claimId: claimIdFor(req.organizationId, req.idempotencyKey) });
                return ready;
            },
            async () => {
                throw new Error('unknown_claim');
            },
            () => undefined,
            () => new Date(),
        );
        builds.request('org-a', 'cell-1', layer('a'));
        builds.request('org-a', 'cell-1', layer('b', 'other-cli'));
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(opened).toHaveLength(1);
        const body = { key: layer('a').key, id: 'some-cli', digest: key('d'), bytes: 1 };
        builds.onResult({ cred: { cellId: 'cell-1', owner: 'kodus' } }, { type: 'toollayer.built', claimId: opened[0].claimId, body } as unknown as Envelope<'toollayer.built'>);
        for (let i = 0; i < 6; i++) await Promise.resolve();
        expect(opened.map((o) => o.cellId)).toEqual(['cell-1', 'cell-1']);
    });

    it('remembers a failure for 10 minutes: no builder, then the same layer is built again', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        t.failed('cell-1', t.opened[0].claimId, layer('a'));
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('recent_failure');
        t.advance(BUILD_FAILURE_MEMORY_MS - 1_000);
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('recent_failure');
        // Another cell, org or key was not the failure.
        expect(t.builds.request('org-a', 'cell-2', layer('a'))).toBe('queued');
        t.advance(2_000);
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('queued');
        await t.settle();
        expect(t.opened.filter((o) => o.cellId === 'cell-1')).toHaveLength(2);
    });

    it('a success clears nothing it must keep: the layer can be asked again after it was built', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        t.built('cell-1', t.opened[0].claimId, layer('a'));
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('queued');
    });

    it('waits behind reviews when the cell has no room, asks again, and gives up after a few tries without remembering a failure', async () => {
        const t = setup(() => noCapacity);
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        expect(t.opened).toHaveLength(1);
        for (let i = 0; i < BUILD_CAPACITY_RETRIES; i++) {
            t.advance(BUILD_CAPACITY_RETRY_MS);
            await t.settle();
        }
        expect(t.opened).toHaveLength(1 + BUILD_CAPACITY_RETRIES);
        t.advance(BUILD_CAPACITY_RETRY_MS * 3);
        await t.settle();
        expect(t.opened).toHaveLength(1 + BUILD_CAPACITY_RETRIES);
        // No room is not the layer's failure: a later miss may ask again at once.
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).not.toBe('recent_failure');
    });

    it('a builder the cell refuses for another reason is a remembered failure', async () => {
        const t = setup(() => ({ status: 'blocked', blockers: [{ kind: 'platform', signature: 'layer_build_refused', message: 'cell_busy' }] }));
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('recent_failure');
    });

    it('a builder that never reports is given up on and remembered as a failure', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        t.advance(BUILD_REPORT_CEILING_MS + 1_000);
        await t.settle();
        expect(t.released).toEqual([t.opened[0].claimId]);
        expect(t.builds.request('org-a', 'cell-1', layer('a'))).toBe('recent_failure');
    });

    it('refuses a result from another cell, for another layer or for a claim that is no builder', async () => {
        const t = setup();
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        const claimId = t.opened[0].claimId;
        expect(t.built('cell-2', claimId, layer('a'))).toBe('unknown');
        expect(t.built('cell-1', claimId, layer('b'))).toBe('unknown');
        expect(t.built('cell-1', 'claim-other', layer('a'))).toBe('unknown');
        expect(t.builds.pending()).toBe(1);
        expect(t.built('cell-1', claimId, layer('a'))).toBe('recorded');
    });

    it('registers the builder before its acquire answers, so a result that arrives first is taken', async () => {
        let resolveAcquire!: (c: Claim) => void;
        const t = setup(() => new Promise<Claim>((r) => (resolveAcquire = r)));
        t.builds.request('org-a', 'cell-1', layer('a'));
        await t.settle();
        expect(t.built('cell-1', t.opened[0].claimId, layer('a'))).toBe('recorded');
        resolveAcquire(ready);
        await t.settle();
        expect(t.builds.pending()).toBe(0);
    });
});
