import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { MAX_KEPT_CHECKS_PER_REPOSITORY } from '@libs/runtime/contracts/kept-check';
import type { ProbeVerdict, RuntimeRunProjection } from '@libs/runtime/run';
import type { ReproducibleProbe } from '@libs/runtime/run/reproduction';

import { RuntimeRunAccessService } from '../application/run-access.service';
import { KeepRuntimeCheckUseCase, ListRuntimeKeptChecksUseCase, RemoveRuntimeKeptCheckUseCase } from '../application/use-cases/kept-checks.use-cases';
import { InMemoryKeptCheckResults, InMemoryKeptChecks, ORG, OTHER_ORG, REPO, realAuthorization, run, storeWith, TEAM, user } from './fixtures';

// Kept checks (docs/runtime/kept-checks.md): a user keeps the probe that proved
// a regression, lists the repository's kept checks with how each did last, and
// removes one. Org-scoped; keeping and removing need "Run again" on the repository.

const PROBE = 'orders-empty-cart';
const spec = { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'POST' as const, path: '/orders', headers: { 'Content-Type': 'application/json' }, body: '{"items":[]}', timeoutMs: 5_000 };
const finding = (over: Partial<ProbeVerdict> = {}): ProbeVerdict => ({ probeId: PROBE, entryPoint: 'POST /orders', verdict: 'finding', findingKind: 'behavior_change', intent: 'unintended', reason: 'r', differingFields: ['status', 'json.error'], ...over });
const recorded = (over: Partial<ReproducibleProbe> = {}): ReproducibleProbe => ({ probeId: PROBE, entryPoint: 'POST /orders', purpose: 'an empty cart is refused', expected: '400', spec, base: { status: 400 }, pr: { status: 500 }, ...over });
const regression = (over: Partial<RuntimeRunProjection> = {}) => run({ findings: [finding()], probes: [finding()], reproduction: { probes: [recorded()] }, ...over });

async function harness(runs: RuntimeRunProjection[], assigned = [REPO]) {
    const access = new RuntimeRunAccessService(await storeWith(...runs), realAuthorization(assigned));
    const store = new InMemoryKeptChecks();
    const results = new InMemoryKeptCheckResults();
    // As GetRuntimeEnvironmentUseCase.load: the caller's org's environment, or 404.
    const environment = {
        load: async (u: { organization?: { uuid?: string } }, id: string) => {
            if (u.organization?.uuid !== ORG || id !== 'env-1') throw new NotFoundException('Environment not found');
            return { env: { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO }, runs: [] } as any;
        },
    };
    return {
        store,
        results,
        keep: new KeepRuntimeCheckUseCase(access, store),
        list: new ListRuntimeKeptChecksUseCase(environment, store, results),
        remove: new RemoveRuntimeKeptCheckUseCase(store, realAuthorization(assigned)),
    };
}

describe('keeping a finding as a check', () => {
    it('keeps the exact probe, main\'s status as its expectation and the fields that diverged', async () => {
        const r = regression();
        const h = await harness([r]);
        const out = await h.keep.execute({ user: user(Role.REPO_ADMIN), body: { runId: r.runId, probeId: PROBE } });
        expect(out.created).toBe(true);
        expect(out.check).toMatchObject({ kind: 'http', exercised: 'POST /orders', entryPoint: 'POST /orders', differingFields: ['status', 'json.error'], source: { runId: r.runId, probeId: PROBE, prNumber: 7 }, stale: false, failuresOnLaterPrs: 0 });
        expect(h.store.rows).toHaveLength(1);
        expect(h.store.rows[0]).toMatchObject({ organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, probe: { spec, purpose: 'an empty cart is refused', expected: '400' }, assertions: { kind: 'http', status: 400 }, keptBy: 'user-repo_admin' });
    });

    it('answers the check already kept when the same probe is kept again', async () => {
        const r = regression();
        const h = await harness([r]);
        const first = await h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } });
        const again = await h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } });
        expect(again).toEqual({ created: false, check: first.check });
        expect(h.store.rows).toHaveLength(1);
    });

    it('refuses a contributor: keeping changes what every later PR runs', async () => {
        const r = regression();
        const h = await harness([r]);
        await expect(h.keep.execute({ user: user(Role.CONTRIBUTOR), body: { runId: r.runId, probeId: PROBE } })).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.store.rows).toEqual([]);
    });

    it('refuses a repo admin the repository is not assigned to', async () => {
        const r = regression();
        const h = await harness([r], ['repo-other']);
        await expect(h.keep.execute({ user: user(Role.REPO_ADMIN), body: { runId: r.runId, probeId: PROBE } })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("answers 404 for another org's Run and for a path that is not a finding", async () => {
        const r = regression();
        const passed = regression({ findings: [], probes: [finding({ verdict: 'not_reproduced', intent: undefined })] });
        const h = await harness([r, passed]);
        await expect(h.keep.execute({ user: user(Role.OWNER, { org: OTHER_ORG }), body: { runId: r.runId, probeId: PROBE } })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.keep.execute({ user: user(Role.OWNER), body: { runId: passed.runId, probeId: PROBE } })).rejects.toBeInstanceOf(NotFoundException);
        expect(h.store.rows).toEqual([]);
    });

    it.each([
        ['a probe that carried a secret-looking value', regression({ reproduction: { probes: [recorded({ spec: { ...spec, headers: { Authorization: 'Bearer [redacted:generic-api-key]' } } })] } })],
        ['a SQL probe', regression({ reproduction: { probes: [recorded({ spec: { kind: 'sql', target: { service: 'db', port: 5432 }, query: 'select 1', timeoutMs: 1_000 } })] } })],
        ['a finding the Run kept no probe of', regression({ reproduction: { probes: [] } })],
        ['a finding where main gave no status', regression({ reproduction: { probes: [recorded({ base: undefined })] } })],
        ['an error on a route main does not have', regression({ findings: [finding({ findingKind: 'new_endpoint_error' })] })],
        ['a finding marked intended', regression({ findings: [finding({ intent: 'intended' })] })],
        ['a finding a kept check made', regression({ findings: [finding({ source: 'kept_check', keptCheckId: '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d' })] })],
    ])('refuses %s and stores nothing', async (_name, r) => {
        const h = await harness([r]);
        await expect(h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } })).rejects.toMatchObject({ status: expect.any(Number) });
        expect(h.store.rows).toEqual([]);
    });

    it('refuses a new check once the repository holds the most it may', async () => {
        const r = regression();
        const h = await harness([r]);
        for (let i = 0; i < MAX_KEPT_CHECKS_PER_REPOSITORY; i++) {
            await h.store.keep({ ...h.store.rows[0], organizationId: ORG, environmentId: 'env-1', repositoryId: REPO, probeKey: `http GET /k${i}`, entryPoint: 'GET /k', probe: { spec: { ...spec, path: `/k${i}` }, purpose: 'p', expected: '200', compare: ['status'] }, differingFields: [], sourceRunId: 'r', sourceProbeId: 'p', sourcePrNumber: 1, keptBy: 'u' }, MAX_KEPT_CHECKS_PER_REPOSITORY);
        }
        await expect(h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } })).rejects.toMatchObject({ status: 409 });
        expect(h.store.rows).toHaveLength(MAX_KEPT_CHECKS_PER_REPOSITORY);
    });
});

describe('listing kept checks', () => {
    it('lists the active checks with how each did last, stale ones first, and the metric of the scope', async () => {
        const r = regression();
        const h = await harness([r]);
        const a = (await h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } })).check;
        const other = regression({ findings: [finding({ probeId: 'list' })], reproduction: { probes: [recorded({ probeId: 'list', spec: { ...spec, method: 'GET', path: '/orders', body: undefined, headers: undefined } })] } });
        const h2 = await harness([other]);
        h2.store.rows = h.store.rows;
        const b = (await h2.keep.execute({ user: user(Role.OWNER), body: { runId: other.runId, probeId: 'list' } })).check;
        h.results.summaryRows = [
            { keptCheckId: a.keptCheckId, last: { outcome: 'failed', runId: 'run-9', prNumber: 9, at: '2026-11-17T10:00:00.000Z' }, failuresOnLaterPrs: 2 },
            { keptCheckId: b.keptCheckId, last: { outcome: 'stale', staleReason: 'route_gone', runId: 'run-9', prNumber: 9, at: '2026-11-17T10:00:00.000Z' }, failuresOnLaterPrs: 0 },
        ];
        h.results.total = 3;
        const view = await h.list.execute({ user: user(Role.CONTRIBUTOR), environmentId: 'env-1' });
        expect(view.checks.map((c) => [c.keptCheckId, c.stale, c.last?.outcome, c.failuresOnLaterPrs])).toEqual([
            [b.keptCheckId, true, 'stale', 0],
            [a.keptCheckId, false, 'failed', 2],
        ]);
        expect(view).toMatchObject({ failuresOnLaterPrs: 3, limit: MAX_KEPT_CHECKS_PER_REPOSITORY });
        expect(view.outcomesUnavailable).toBeUndefined();
    });

    it('still lists the checks when the Runtime database cannot be read, and says the outcomes are missing, not zero', async () => {
        const r = regression();
        const h = await harness([r]);
        await h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } });
        h.results.unavailable = true;
        const view = await h.list.execute({ user: user(Role.OWNER), environmentId: 'env-1' });
        expect(view.checks).toHaveLength(1);
        expect(view.outcomesUnavailable).toBe(true);
        expect(view.checks[0].last).toBeUndefined();
    });

    it("answers 404 for another org's environment", async () => {
        const h = await harness([]);
        await expect(h.list.execute({ user: user(Role.OWNER, { org: OTHER_ORG }), environmentId: 'env-1' })).rejects.toBeInstanceOf(NotFoundException);
    });
});

describe('removing a kept check', () => {
    it('removes it: it no longer lists', async () => {
        const r = regression();
        const h = await harness([r]);
        const { check } = await h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } });
        await expect(h.remove.execute({ user: user(Role.REPO_ADMIN), keptCheckId: check.keptCheckId })).resolves.toEqual({ removed: true });
        expect((await h.list.execute({ user: user(Role.OWNER), environmentId: 'env-1' })).checks).toEqual([]);
        expect(h.store.rows[0]).toMatchObject({ removedBy: 'user-repo_admin' });
    });

    it("refuses a contributor, and answers 404 for another org's check", async () => {
        const r = regression();
        const h = await harness([r]);
        const { check } = await h.keep.execute({ user: user(Role.OWNER), body: { runId: r.runId, probeId: PROBE } });
        await expect(h.remove.execute({ user: user(Role.CONTRIBUTOR), keptCheckId: check.keptCheckId })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(h.remove.execute({ user: user(Role.OWNER, { org: OTHER_ORG }), keptCheckId: check.keptCheckId })).rejects.toBeInstanceOf(NotFoundException);
        expect((await h.list.execute({ user: user(Role.OWNER), environmentId: 'env-1' })).checks).toHaveLength(1);
    });
});
