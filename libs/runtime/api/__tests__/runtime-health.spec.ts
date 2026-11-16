import { GetRuntimeHealthUseCase } from '../application/use-cases/runtime-health.use-case';
import { buildRuntimeHealth, type RuntimeHealthInput } from '../domain/runtime-health';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const base = (over: Partial<RuntimeHealthInput> = {}): RuntimeHealthInput => ({
    organizationId: 'org-1',
    now: NOW,
    setups: [
        { environmentId: 'env-a', organizationId: 'org-1', setupKey: 'k-a', state: 'active', requestedAt: ago(600), updatedAt: ago(590) },
        { environmentId: 'env-b', organizationId: 'org-1', setupKey: 'k-b', state: 'blocked', requestedAt: ago(600), updatedAt: ago(590) },
    ],
    runs: [
        { runId: 'r1', state: 'regression', verdictState: 'regression', requestedAt: ago(60), bootMs: 120_000 },
        { runId: 'r2', state: 'no_regressions', verdictState: 'no_regressions', requestedAt: ago(120), bootMs: 60_000 },
        { runId: 'r3', state: 'no_regressions', verdictState: 'no_regressions', requestedAt: ago(9 * 24 * 60), bootMs: 60_000 },
    ],
    liveRuns: [{ runId: 'r-stuck', organizationId: 'org-1', environmentId: 'env-a', state: 'queued', requestedAt: ago(120) }],
    openClaims: [],
    blockers: [
        { kind: 'missing_env', signature: 'missing_env:DATABASE_URL', message: 'DATABASE_URL is not set', at: ago(30), environmentId: 'env-b', source: 'setup' },
        { kind: 'missing_env', signature: 'missing_env:DATABASE_URL', message: 'DATABASE_URL is not set', at: ago(10), runId: 'r1', environmentId: 'env-b', source: 'run' },
    ],
    cells: [],
    sessions: [],
    claimsToday: [],
    spendToday: [],
    unitPrices: null,
    ...over,
});

describe('the Runtime Health view', () => {
    it('counts setups by state, the week’s Runs by verdict, and compares boot p95 with the week before', () => {
        const h = buildRuntimeHealth(base());
        expect(h.summary.setups).toEqual({ measured: true, active: 1, blocked: 1, settingUp: 0 });
        expect(h.summary.runs).toEqual({ measured: true, days: 7, total: 2, byVerdict: { regression: 1, no_regressions: 1 } });
        expect(h.summary.boot).toMatchObject({ measured: true, thisWeek: { count: 2, p95Ms: 120_000 }, lastWeek: { count: 1, p95Ms: 60_000 }, trend: 'slower' });
    });

    it('lists what is stuck past its bound with a link to where the product shows it, and names what it cannot check here', () => {
        const h = buildRuntimeHealth(base());
        expect(h.stuck).toMatchObject({ measured: true, items: [{ subject: 'run', state: 'queued', runId: 'r-stuck', link: { kind: 'run', runId: 'r-stuck' } }], notChecked: ['admission requests', 'DBOS workflows'] });
    });

    it('groups errors by blocker signature with the catalog’s title, the newest occurrence first to link', () => {
        const h = buildRuntimeHealth(base());
        expect(h.errors).toMatchObject({ measured: true, bySignature: [{ signature: 'missing_env:DATABASE_URL', kind: 'missing_env', count: 2, lastAt: ago(10), runId: 'r1' }] });
        expect((h.errors as { bySignature: Array<{ title: string }> }).bySignature[0].title).toMatch(/DATABASE_URL/);
    });

    it('says "not measured" with the reason where a source is missing, never a zero', () => {
        const h = buildRuntimeHealth(base({ setups: undefined, runs: undefined, blockers: undefined, claimsToday: undefined }));
        for (const part of [h.summary.setups, h.summary.runs, h.summary.boot, h.stuck, h.errors, h.cost.today]) expect(part).toMatchObject({ measured: false, reason: expect.any(String) });
        expect(buildRuntimeHealth(base()).cells).toMatchObject({ pool: { measured: false } });
    });

    it('gives today’s total only when both the LLM and the machine parts are priced', () => {
        const claim = { claimId: 'c1', cellId: 'cell', side: 'pr', state: 'released', driver: 'docker-gvisor', bootMb: 2048, readyMb: 1024, allocatableMb: 8192, cpus: 2, admittedAt: ago(30), readyAt: ago(20), releasedAt: ago(10), stateChangedAt: ago(10), hardExpiresAt: ago(-30) };
        const noPrice = buildRuntimeHealth(base({ claimsToday: [claim] })).cost.today;
        expect(noPrice).toMatchObject({ measured: true, machineUsd: null, totalUsd: null, complete: false, gbMinutes: 30, vcpuMinutes: 40 });
        const priced = buildRuntimeHealth(base({ claimsToday: [claim], unitPrices: { usdPerGbMinute: 0.01, usdPerVcpuMinute: 0.001 } })).cost.today;
        expect(priced).toMatchObject({ measured: true, machineUsd: 0.34, llmUsd: 0, totalUsd: 0.34, complete: true });
    });
});

describe('GetRuntimeHealthUseCase', () => {
    const reader = (b: RuntimeHealthInput) => ({
        setups: async () => b.setups!,
        runs: async () => b.runs!,
        liveRuns: async () => [],
        openClaims: async () => [],
        blockers: async () => b.blockers!,
        cells: async () => [],
        sessions: async () => [],
    });
    const usage = { claimsOfMonth: async () => ({ claims: [], truncated: false }) } as never;
    const make = (environments?: { listByOrganization: () => Promise<Array<{ environmentId: string }>> }) =>
        new GetRuntimeHealthUseCase(reader(base()) as never, usage, { machineUnitPrices: undefined }, () => NOW, undefined, environments as never);
    const user = { organization: { uuid: 'org-1' } } as never;

    it('counts and links only the environments the product still has: a deleted one keeps its setups in the Runtime', async () => {
        const h = await make({ listByOrganization: async () => [{ environmentId: 'env-a' }] }).execute({ user });
        expect(h.summary.setups).toMatchObject({ measured: true, active: 1, blocked: 0 });
        // env-b's setup failure is gone with it; the Run's failure there still happened.
        expect((h.errors as { bySignature: Array<{ count: number }> }).bySignature.map((e) => e.count)).toEqual([1]);
    });

    it('counts every setup the Runtime has when the product list is not there to read', async () => {
        const h = await make().execute({ user });
        expect(h.summary.setups).toMatchObject({ active: 1, blocked: 1 });
        const failing = await make({ listByOrganization: async () => Promise.reject(new Error('down')) }).execute({ user });
        expect(failing.summary.setups).toMatchObject({ active: 1, blocked: 1 });
    });
});
