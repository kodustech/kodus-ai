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

    it("prices today's claims on the org's own cells at its price per host-hour, and the other claims as before", () => {
        const own = { claimId: 'c-own', cellId: 'cell-own', side: 'pr', state: 'released', driver: 'docker-gvisor', bootMb: 2048, readyMb: 1024, allocatableMb: 8192, cpus: 2, admittedAt: ago(30), readyAt: ago(20), releasedAt: ago(10), stateChangedAt: ago(10), hardExpiresAt: ago(-30) };
        const kodus = { ...own, claimId: 'c-kodus', cellId: 'cell-kodus' };
        const cells = [{ cellId: 'cell-own', owner: 'customer' as const, status: 'active', connected: true, lastHeartbeatAt: null, freeSlots: 1, isolation: null, driver: 'docker-gvisor', maxClaimMemoryMb: null, maxClaimCpus: null }];
        // 2 048 MB × 10 min + 1 024 MB × 10 min of an 8 192 MB host at US$ 0.80/h: 30 720 / 8 192 × 0.8 / 60 = US$ 0.05.
        const ownOnly = buildRuntimeHealth(base({ cells, claimsToday: [own], ownHostUsdPerHour: 0.8 })).cost.today;
        expect(ownOnly).toMatchObject({ measured: true, machineUsd: 0.05, totalUsd: 0.05, complete: true, gbMinutes: 30, ownHostUsdPerHour: 0.8 });
        // A Kodus cell's claim keeps the unit prices (0.34 for the same claim, as above).
        const both = buildRuntimeHealth(base({ cells, claimsToday: [own, kodus], ownHostUsdPerHour: 0.8, unitPrices: { usdPerGbMinute: 0.01, usdPerVcpuMinute: 0.001 } })).cost.today;
        expect(both).toMatchObject({ machineUsd: 0.39, gbMinutes: 60 });
        // No unit price for the Kodus cell's claim: the machine part is not priced, never half of it.
        expect(buildRuntimeHealth(base({ cells, claimsToday: [own, kodus], ownHostUsdPerHour: 0.8 })).cost.today).toMatchObject({ machineUsd: null, totalUsd: null });
        // Without the org's price its own cells stay as before: the unit prices, or nothing.
        expect(buildRuntimeHealth(base({ cells, claimsToday: [own] })).cost.today).toMatchObject({ machineUsd: null, ownHostUsdPerHour: null });
        // A claim on its own cell that did not record its memory: not priced, never a guess.
        expect(buildRuntimeHealth(base({ cells, claimsToday: [{ ...own, allocatableMb: null }], ownHostUsdPerHour: 0.8 })).cost.today).toMatchObject({ machineUsd: null });
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

    it("prices today's machines on the org's own cells at the price per host-hour it set; unset or unreadable, they stay unpriced", async () => {
        const own = { claimId: 'c-own', cellId: 'cell-own', side: 'pr', state: 'released', driver: 'docker-gvisor', bootMb: 2048, readyMb: 1024, allocatableMb: 8192, cpus: 2, admittedAt: ago(30), readyAt: ago(20), releasedAt: ago(10), stateChangedAt: ago(10), hardExpiresAt: ago(-30) };
        const cell = { cellId: 'cell-own', owner: 'customer' as const, status: 'active', connected: true, lastHeartbeatAt: null, freeSlots: 1, isolation: null, driver: 'docker-gvisor', maxClaimMemoryMb: null, maxClaimCpus: null };
        const withCells = { ...reader(base()), cells: async () => [cell] };
        const today = { claimsOfMonth: async () => ({ claims: [own], truncated: false }) } as never;
        const health = (settings?: { getOrganization: () => Promise<unknown> }) =>
            new GetRuntimeHealthUseCase(withCells as never, today, { machineUnitPrices: undefined }, () => NOW, undefined, undefined, settings as never).execute({ user });

        expect((await health({ getOrganization: async () => ({ tokenBudgetPerDay: null, machineUsdPerHostHour: 0.8 }) })).cost.today).toMatchObject({ machineUsd: 0.05, ownHostUsdPerHour: 0.8 });
        expect((await health({ getOrganization: async () => null })).cost.today).toMatchObject({ machineUsd: null, gbMinutes: 30 });
        expect((await health({ getOrganization: async () => Promise.reject(new Error('down')) })).cost.today).toMatchObject({ machineUsd: null, gbMinutes: 30 });
    });
});
