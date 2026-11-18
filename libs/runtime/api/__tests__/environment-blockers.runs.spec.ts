import type { RuntimeRunProjection } from '@libs/runtime/run';

import { blockerGroups } from '../application/use-cases/environments.use-cases';

const run = (patch: Partial<RuntimeRunProjection>): RuntimeRunProjection =>
    ({ runId: 'r', prNumber: 1, state: 'could_not_boot', updatedAt: '2026-11-17T00:20:00.000Z', ...patch }) as RuntimeRunProjection;

describe("an environment's blockers from its Runs that could not boot", () => {
    it('reads the kind and the signature out of the Run reason, so the catalog names the cause', () => {
        const [g] = blockerGroups(null, [run({ reason: 'platform:repo_fetch', finishedAt: '2026-11-17T00:20:28.000Z' })]);
        expect(g).toMatchObject({ kind: 'platform', signature: 'repo_fetch', title: 'Kodus failed while downloading the repository', count: 1, lastPr: 1 });
    });

    it('reads every blocker a Run reason names', () => {
        const groups = blockerGroups(null, [run({ reason: 'platform:repo_fetch, platform:claim_network', finishedAt: '2026-11-17T00:20:28.000Z' })]);
        expect(groups.map((g) => g.signature).sort()).toEqual(['claim_network', 'repo_fetch']);
    });

    it('keeps a reason that names no blocker kind as it is', () => {
        const [g] = blockerGroups(null, [run({ reason: 'the base machine could not boot', finishedAt: '2026-11-17T00:20:28.000Z' })]);
        expect(g.signature).toBe('the base machine could not boot');
    });

    it('drops a failure on Kodus\'s side once a later Run booted on the environment', () => {
        const groups = blockerGroups(null, [
            run({ runId: 'a', reason: 'platform:repo_fetch', requestedAt: '2026-11-17T00:20:09.000Z', finishedAt: '2026-11-17T00:20:28.000Z' }),
            run({ runId: 'b', state: 'regression', requestedAt: '2026-11-17T00:40:45.000Z', finishedAt: '2026-11-17T01:01:00.000Z' }),
        ]);
        expect(groups).toEqual([]);
    });

    it('keeps a failure of the repository or of one PR even after another Run booted', () => {
        const groups = blockerGroups(null, [
            run({ runId: 'a', reason: 'npm ci: ENOTFOUND registry', requestedAt: '2026-11-17T00:20:09.000Z', finishedAt: '2026-11-17T00:20:28.000Z' }),
            run({ runId: 'b', state: 'regression', requestedAt: '2026-11-17T00:40:45.000Z', finishedAt: '2026-11-17T01:01:00.000Z' }),
        ]);
        expect(groups.map((g) => g.signature)).toEqual(['npm ci: ENOTFOUND registry']);
    });

    it('keeps a blocker seen after the last Run that booted', () => {
        const groups = blockerGroups(null, [
            run({ runId: 'b', state: 'no_regressions', requestedAt: '2026-11-17T00:40:45.000Z', finishedAt: '2026-11-17T01:01:00.000Z' }),
            run({ runId: 'a', reason: 'platform:repo_fetch', requestedAt: '2026-11-17T02:20:09.000Z', finishedAt: '2026-11-17T02:20:28.000Z' }),
        ]);
        expect(groups.map((g) => g.signature)).toEqual(['repo_fetch']);
    });
});

describe('the "approve this host" card of a PR boot the egress proxy stopped (D7, 2026-11-18)', () => {
    const denied = (patch: Partial<RuntimeRunProjection> = {}) =>
        run({
            state: 'partly_tested',
            prNumber: 7,
            bootFailure: { side: 'pr', kind: 'external_service', signature: 'external_service:egress:api.vendor.test', title: 'x', logTail: [], at: '2026-11-18T10:00:00.000Z', deniedHosts: ['api.vendor.test'] },
            ...patch,
        });

    it('offers to allow the host the proxy denied the PR, as a one-click fix', () => {
        const [g] = blockerGroups(null, [denied()]);
        expect(g).toMatchObject({ kind: 'external_service', signature: 'external_service:egress:api.vendor.test', lastPr: 7 });
        expect(g.fixes[0]).toMatchObject({ action: 'approve_host', host: 'api.vendor.test', who: 'one_click' });
    });

    it('a boot failure without the proxy\'s record, or a regression, offers no host', () => {
        expect(blockerGroups(null, [denied({ bootFailure: { side: 'pr', kind: 'external_service', signature: 's', title: 'x', logTail: [], at: '2026-11-18T10:00:00.000Z' } })])).toEqual([]);
        expect(blockerGroups(null, [denied({ state: 'regression' })])).toEqual([]);
    });
});
