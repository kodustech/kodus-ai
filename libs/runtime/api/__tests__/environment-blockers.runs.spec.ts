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

describe('a blocker that a later success cleared', () => {
    const setup = (patch: Record<string, unknown>) => ({ state: 'active', blockers: [], finishedAt: '2026-11-17T06:00:00.000Z', ...patch }) as unknown as Parameters<typeof blockerGroups>[0];
    const timedOut = run({ runId: 'a', prNumber: 6, reason: 'resources:boot_timeout', requestedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:10:00.000Z' });

    // Behavior: the environment's latest setup finished active after the blocker was last seen, so the blocker is reported fixed, with the moment.
    it('is fixed when the latest setup finished active after its last sighting', () => {
        const [g] = blockerGroups(setup({ blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'm', at: '2026-11-17T00:10:00.000Z' }] }), []);
        expect(g).toMatchObject({ signature: 'boot_timeout', state: 'fixed', resolvedAt: '2026-11-17T06:00:00.000Z' });
    });

    // Behavior: a setup that did not succeed clears nothing.
    it('stays open when the latest setup did not finish active', () => {
        const [g] = blockerGroups(setup({ state: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'm', at: '2026-11-17T00:10:00.000Z' }] }), []);
        expect(g.state).toBe('open');
    });

    // Behavior: a blocker seen after the successful setup is the current problem.
    it('stays open when it was seen after the successful setup', () => {
        const [g] = blockerGroups(setup({ finishedAt: '2026-11-16T23:00:00.000Z' }), [timedOut]);
        expect(g.state).toBe('open');
    });

    // Behavior: a later Run of the same pull request that booted clears that pull request's blocker; another pull request's Run does not.
    it('is fixed by a later booted Run of the same pull request only', () => {
        const same = run({ runId: 'b', prNumber: 6, state: 'no_regressions', requestedAt: '2026-11-17T01:00:00.000Z', finishedAt: '2026-11-17T01:10:00.000Z' });
        const other = run({ runId: 'c', prNumber: 7, state: 'no_regressions', requestedAt: '2026-11-17T01:00:00.000Z', finishedAt: '2026-11-17T01:10:00.000Z' });
        expect(blockerGroups(null, [timedOut, same])[0]).toMatchObject({ state: 'fixed', resolvedAt: '2026-11-17T01:00:00.000Z' });
        expect(blockerGroups(null, [timedOut, other])[0].state).toBe('open');
    });

    // Behavior: a failure seen on a pull request's Run stays open after main's setup succeeds.
    it('keeps a pull request failure open when only main\'s setup succeeded', () => {
        const npm = run({ runId: 'p', prNumber: 9, reason: 'npm ci: ENOTFOUND registry', requestedAt: '2026-11-17T00:00:00.000Z', finishedAt: '2026-11-17T00:10:00.000Z' });
        const [g] = blockerGroups(setup({}), [npm]);
        expect(g).toMatchObject({ signature: 'npm ci: ENOTFOUND registry', state: 'open' });
        expect(g.resolvedAt).toBeUndefined();
    });

    // Behavior: the open blockers come before the fixed ones, whatever their counts.
    it('lists the open blockers before the fixed ones', () => {
        const newer = run({ runId: 'n', prNumber: 8, reason: 'missing_env:API_KEY', requestedAt: '2026-11-17T07:00:00.000Z', finishedAt: '2026-11-17T07:10:00.000Z' });
        const groups = blockerGroups(setup({ blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'm', at: '2026-11-17T00:10:00.000Z' }, { kind: 'resources', signature: 'boot_timeout', message: 'm', at: '2026-11-17T00:20:00.000Z' }] }), [newer]);
        expect(groups.map((g) => [g.signature, g.state])).toEqual([['API_KEY', 'open'], ['boot_timeout', 'fixed']]);
    });
});
