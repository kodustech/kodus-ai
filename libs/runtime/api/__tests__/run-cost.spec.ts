import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { RuntimeRunCostService } from '../application/run-cost.service';
import { ListRuntimeRunsUseCase } from '../application/use-cases/list-runs.use-case';
import { claimMbMinutes, estimateRunCost, machineMinutesOf, type RunClaimUsage, RUNTIME_MACHINE_LIST_PRICES } from '../domain/run-cost';
import type { RuntimeClaimUsageReader, RuntimeLlmSpendReader } from '../domain/ports';
import { parseCellPrices } from '../infrastructure/runtime-api.config';
import { clock, InMemoryLlmSpend, NOW, ORG, REPO, realAuthorization, run, spendRow, storeWith, user } from './fixtures';

// §13 PR 5: the cost of each Run, machines and LLM, as an estimate from list prices.
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
/** One claim round as the hub records it (runtime_claims, migration 11). */
const claim = (patch: Partial<RunClaimUsage> = {}): RunClaimUsage => ({
    claimId: 'c-pr',
    cellId: 'cell-dev-1',
    side: 'pr',
    state: 'released',
    driver: 'docker-gvisor',
    bootMb: 12_288,
    readyMb: 2_048,
    allocatableMb: 14_745,
    admittedAt: at(-8),
    readyAt: at(-8 + 25 / 60),
    releasedAt: at(0),
    stateChangedAt: at(0),
    hardExpiresAt: at(60),
    ...patch,
});
const ec2 = (side = 'pr') => claim({ claimId: `c-${side}`, side, driver: 'aws-ec2', bootMb: null, readyMb: null, allocatableMb: null, admittedAt: at(-10) });
const T4G = { instanceType: 't4g.xlarge', usdPerHour: 0.1344, region: 'us-east-2' };
const cellPriceOf = (cellId: string) => (cellId === 'cell-dev-1' ? T4G : null);

describe('estimateRunCost', () => {
    it('ten minutes of two VMs and two observers are about US$ 0.10 at the list prices of the instances the cell starts', () => {
        const cost = estimateRunCost({ run: { bootingAt: at(-10), finishedAt: at(0) }, spend: [], claims: [ec2('base'), ec2('pr')], cellPriceOf, now: NOW });
        expect(cost.machines).toMatchObject({ model: 'vm', minutes: 10, usd: 0.09695, paidBy: 'kodus', region: 'us-east-1' });
        expect(cost.machines.mbMinutes).toBeUndefined();
        expect(cost.machines.vm).toEqual(RUNTIME_MACHINE_LIST_PRICES.vm);
        expect(cost).toMatchObject({ estimate: true, currency: 'USD', totalUsd: 0.09695, complete: true, llm: { tokens: 0, usd: 0 } });
    });

    it('counts machine time from the boot request, to now while the Run is live, and none before booting', () => {
        expect(machineMinutesOf({ bootingAt: at(-3) }, NOW)).toBe(3);
        expect(machineMinutesOf({ startedAt: at(-2), finishedAt: at(-1) }, NOW)).toBe(1);
        expect(machineMinutesOf({}, NOW)).toBe(0);
        expect(machineMinutesOf({ bootingAt: at(1), finishedAt: at(0) }, NOW)).toBe(0);
    });

    it("is the Run's usage spans by model and by agent, with what the org's own key paid apart", () => {
        const cost = estimateRunCost({
            run: { bootingAt: at(-10), finishedAt: at(0) },
            claims: [ec2()],
            spend: [
                spendRow({ agent: 'planner', inputTokens: 300_000, outputTokens: 1_000, totalTokens: 301_000, aboveBaseTierTokens: 301_000, usd: 1.83 }),
                spendRow({ agent: 'run_agent', usd: 0.0045 }),
                spendRow({ agent: 'intent', model: 'gpt-5-mini', paidBy: 'customer', inputTokens: 500, outputTokens: 50, totalTokens: 550, usd: 0.0002 }),
            ],
            now: NOW,
        });
        expect(cost.llm).toMatchObject({ source: 'telemetry', tokens: 302_650, usd: 1.8347, customerUsd: 0.0002 });
        expect(cost.llm.models).toEqual([
            { model: 'claude-sonnet-4-5', inputTokens: 301_000, outputTokens: 1_100, cacheReadTokens: 0, cacheWriteTokens: 0, aboveBaseTierTokens: 301_000, usd: 1.8345 },
            { model: 'gpt-5-mini', inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, aboveBaseTierTokens: 0, usd: 0.0002 },
        ]);
        expect(cost.llm.agents.map((a) => a.agent)).toEqual(['planner', 'run_agent', 'intent']);
        expect(cost.totalUsd).toBe(round(cost.machines.usd! + 1.8347));
        expect(cost.complete).toBe(true);
    });

    it('never invents a price: an unknown model, spans that cannot be read or a customer cell leave that part null', () => {
        const unknown = estimateRunCost({
            run: { bootingAt: at(-1), finishedAt: at(0) },
            claims: [ec2()],
            spend: [spendRow({ model: 'mystery', usd: null }), spendRow({ usd: 0.01 })],
            now: NOW,
        });
        expect(unknown.llm.usd).toBeNull();
        expect(unknown.llm.models.find((m) => m.model === 'mystery')!.usd).toBeNull();
        expect(unknown.complete).toBe(false);
        expect(unknown.totalUsd).toBe(round(unknown.machines.usd! + 0.01));

        const unread = estimateRunCost({ run: { bootingAt: at(-1), finishedAt: at(0) }, claims: [ec2()], spend: undefined, now: NOW });
        expect(unread.llm).toMatchObject({ source: 'not_measured', usd: null, tokens: 0 });
        expect(unread.complete).toBe(false);

        const customer = estimateRunCost({
            run: { bootingAt: at(-10), finishedAt: at(0), cellOwner: 'customer' },
            spend: [],
            claims: [ec2()],
            now: NOW,
        });
        expect(customer.machines).toMatchObject({ model: 'vm', minutes: 10, usd: null, paidBy: 'customer' });
        expect(customer.complete).toBe(false);
    });
});

describe('estimateRunCost on a shared cell (docker-gvisor, ADR-070)', () => {
    // demo-shop-like: the Run waited 3 min for room (no claim recorded, nothing held), then the base held its
    // ready size 8 min and the PR its build size 25 s, then its ready size, on a t4g.xlarge with 14 745 MB to commit.
    const shop = [
        claim({ claimId: 'c-base', side: 'base', bootMb: 2_048, readyMb: 2_048, readyAt: at(-7.9) }),
        claim(),
    ];

    it('prices the share of the host each claim held: build size until ready, ready size after; the wait costs nothing', () => {
        const cost = estimateRunCost({
            run: { bootingAt: at(-8), finishedAt: at(0) },
            spend: [],
            claims: shop,
            cellPriceOf,
            now: NOW,
        });
        // 2 048 × 8 + 12 288 × 25/60 + 2 048 × (8 − 25/60) = 37 034.67 MB·min; / 14 745 × 0.1344 / 60.
        expect(cost.machines).toEqual({
            minutes: 8,
            vm: RUNTIME_MACHINE_LIST_PRICES.vm,
            observer: RUNTIME_MACHINE_LIST_PRICES.observer,
            region: 'us-east-1',
            paidBy: 'kodus',
            model: 'shared_cell',
            mbMinutes: 37_034.666667,
            usd: 0.005626,
            host: { cellId: 'cell-dev-1', instanceType: 't4g.xlarge', usdPerHour: 0.1344, region: 'us-east-2' },
        });
        expect(cost).toMatchObject({ totalUsd: 0.005626, complete: true });
        // The per-VM price of the same 8 minutes, for scale: 14× more.
        expect(estimateRunCost({ run: { bootingAt: at(-8), finishedAt: at(0) }, spend: [], claims: [ec2()], now: NOW }).machines.usd).toBe(0.07756);
    });

    it('a claim still open is held until now (never past its ceiling); one that failed and is not released, until it failed', () => {
        expect(claimMbMinutes(claim({ state: 'bound', releasedAt: null, readyAt: at(-1), admittedAt: at(-2) }), NOW)).toBeCloseTo(12_288 + 2_048, 6);
        expect(claimMbMinutes(claim({ state: 'bound', releasedAt: null, readyAt: null, admittedAt: at(-2), hardExpiresAt: at(-1) }), NOW)).toBeCloseTo(12_288, 6);
        expect(claimMbMinutes(claim({ state: 'failed', releasedAt: null, readyAt: null, admittedAt: at(-3), stateChangedAt: at(-1) }), NOW)).toBeCloseTo(2 * 12_288, 6);
    });

    it('a customer cell stays unpriced, with what it held still shown', () => {
        const cost = estimateRunCost({ run: { bootingAt: at(-8), finishedAt: at(0), cellOwner: 'customer' }, spend: [], claims: shop, cellPriceOf, now: NOW });
        expect(cost.machines).toMatchObject({ model: 'shared_cell', mbMinutes: 37_034.666667, usd: null, paidBy: 'customer' });
        expect(cost.machines.host).toBeUndefined();
        expect(cost.complete).toBe(false);
    });

    it("prices the org's own cell at the price per host-hour it set, by the share of the host its claims held; the org still pays it", () => {
        const ownHostPrice = { usdPerHour: 0.1344, cellIds: new Set(['cell-dev-1']) };
        const cost = estimateRunCost({ run: { bootingAt: at(-8), finishedAt: at(0), cellOwner: 'customer' }, spend: [], claims: shop, cellPriceOf, ownHostPrice, now: NOW });
        // The same share as a Kodus t4g.xlarge at the same price: 37 034.67 MB·min / 14 745 × 0.1344 / 60.
        expect(cost.machines).toMatchObject({ model: 'shared_cell', mbMinutes: 37_034.666667, usd: 0.005626, paidBy: 'customer', ownHostUsdPerHour: 0.1344 });
        expect(cost.machines.host).toBeUndefined();
        expect(cost.machines.unpriced).toBeUndefined();
        expect(cost).toMatchObject({ totalUsd: 0.005626, complete: true });
    });

    it("never prices at the org's price a claim on a cell that is not the org's own, nor a per-VM customer cell", () => {
        const run = { bootingAt: at(-8), finishedAt: at(0), cellOwner: 'customer' as const };
        const notOurs = estimateRunCost({ run, spend: [], claims: shop, ownHostPrice: { usdPerHour: 0.2, cellIds: new Set(['cell-own']) }, now: NOW });
        expect(notOurs.machines).toMatchObject({ model: 'shared_cell', usd: null, paidBy: 'customer', unpriced: 'cell_price_unknown' });
        expect(notOurs.complete).toBe(false);
        // An aws-ec2 cell of the org: one VM per claim, of a size the product does not know. It stays unpriced.
        const vm = estimateRunCost({ run, spend: [], claims: [ec2()], ownHostPrice: { usdPerHour: 0.2, cellIds: new Set(['cell-dev-1']) }, now: NOW });
        expect(vm.machines).toMatchObject({ model: 'vm', usd: null, paidBy: 'customer' });
        expect(vm.machines.ownHostUsdPerHour).toBeUndefined();
    });

    it('missing facts are "not priced", never a guessed number', () => {
        const run = { bootingAt: at(-8), finishedAt: at(0) };
        const base = { run, spend: [], cellPriceOf, now: NOW };
        // A cell with no price configured: what was held, and no number.
        expect(estimateRunCost({ ...base, claims: [claim({ cellId: 'cell-x' })] }).machines).toMatchObject({ model: 'shared_cell', usd: null, unpriced: 'cell_price_unknown', mbMinutes: 20_650.666667 });
        // A shared cell that reported no memory, a row from before migration 11, or claims that could not be read.
        for (const claims of [[claim({ bootMb: null, readyMb: null, allocatableMb: null })], [claim({ driver: null, admittedAt: null, bootMb: null, readyMb: null, allocatableMb: null })], undefined]) {
            const cost = estimateRunCost({ ...base, claims });
            expect(cost.machines).toMatchObject({ model: 'unknown', usd: null, unpriced: 'missing_claim_facts' });
            expect(cost.complete).toBe(false);
        }
        // One side priced and the other without facts: the whole machine part is unpriced, not half of it.
        expect(estimateRunCost({ ...base, claims: [claim(), claim({ claimId: 'c-base', allocatableMb: null })] }).machines).toMatchObject({ usd: null, unpriced: 'missing_claim_facts' });
        // A Run that never held a machine costs nothing.
        expect(estimateRunCost({ ...base, run: {}, claims: [] }).machines).toMatchObject({ model: 'unknown', usd: 0 });
    });

    it('RUNTIME_CELL_PRICES: an instance type alone takes its list price; anything unreadable prices nothing', () => {
        expect(parseCellPrices('{"cell-dev-1":{"instanceType":"t4g.xlarge"},"big":{"instanceType":"c8g.4xlarge","usdPerHour":0.7,"region":"us-east-1"}}')).toEqual({
            'cell-dev-1': T4G,
            big: { instanceType: 'c8g.4xlarge', usdPerHour: 0.7, region: 'us-east-1' },
        });
        expect(parseCellPrices('{"x":{"instanceType":"z9.mega"},"y":{},"z":3}')).toEqual({});
        expect(parseCellPrices('not json')).toEqual({});
        expect(parseCellPrices(undefined)).toEqual({});
    });
});

describe('RuntimeRunCostService and the Run list', () => {
    it("prices each Run of the list from its own spans, in one read per org around the Runs' time", async () => {
        const r = run({ state: 'testing', requestedAt: at(-6), bootingAt: at(-5) });
        const idle = run({ state: 'queued', requestedAt: at(-1) });
        const spend = new InMemoryLlmSpend([
            spendRow({ runId: r.runId, usd: 0.00345 }),
            spendRow({ runId: 'another-run', usd: 9 }),
            spendRow({ runId: r.runId, organizationId: 'org-other', usd: 9 }),
        ]);
        const list = new ListRuntimeRunsUseCase(await storeWith(r, idle), realAuthorization(), new RuntimeRunCostService(clock, spend));
        const rows = await list.execute({ user: user(Role.OWNER), repositoryId: REPO });

        expect(spend.reads).toHaveLength(1);
        expect(spend.reads[0].start.getTime()).toBeLessThanOrEqual(Date.parse(at(-6)));
        expect(spend.reads[0].end.getTime()).toBeGreaterThanOrEqual(NOW.getTime());
        const live = rows.find((x) => x.runId === r.runId)!.cost!;
        expect(live.machines.minutes).toBe(5);
        expect(live.llm).toMatchObject({ source: 'telemetry', tokens: 1_100, usd: 0.00345 });
        expect(rows.find((x) => x.runId === idle.runId)!.cost).toMatchObject({ machines: { minutes: 0, usd: 0 }, llm: { tokens: 0, usd: 0 }, totalUsd: 0 });
    });

    it('spans that cannot be read leave the LLM part "not measured" and the Run still loads', async () => {
        const r = run({ bootingAt: at(-2), finishedAt: at(0) });
        const broken: RuntimeLlmSpendReader = { spendOf: async () => Promise.reject(new Error('telemetry down')) };
        const claims: RuntimeClaimUsageReader = { claimsOfRuns: async () => new Map([[r.runId, [ec2()]]]) };
        const cost = (await new RuntimeRunCostService(clock, broken, claims).forRuns([r])).get(r.runId)!;
        expect(cost.llm).toMatchObject({ source: 'not_measured', usd: null });
        expect(cost.machines.usd).toBeGreaterThan(0);
        // A deployment with no telemetry store at all (the product worker) says the same.
        const none = (await new RuntimeRunCostService(clock, { spendOf: async () => undefined }).forRuns([r])).get(r.runId)!;
        expect(none.llm.source).toBe('not_measured');
    });

    it("reads the page's claims once per org and prices a shared cell by RUNTIME_CELL_PRICES; claims that cannot be read leave machines unpriced", async () => {
        const mine = run({ bootingAt: at(-8), finishedAt: at(0) });
        const theirs = run({ organizationId: 'org-other', bootingAt: at(-8), finishedAt: at(0) });
        const asked: Array<[string, string[]]> = [];
        const reader: RuntimeClaimUsageReader = {
            claimsOfRuns: async (org, ids) => (asked.push([org, ids]), new Map(ids.map((id) => [id, [claim()]]))),
        };
        const cellPrices = parseCellPrices('{"cell-dev-1":{"instanceType":"t4g.xlarge","region":"us-east-2"}}');
        const costs = await new RuntimeRunCostService(clock, new InMemoryLlmSpend(), reader, { cellPrices }).forRuns([mine, theirs]);
        expect(asked).toEqual([
            [ORG, [mine.runId]],
            ['org-other', [theirs.runId]],
        ]);
        expect(costs.get(mine.runId)!.machines).toMatchObject({ model: 'shared_cell', host: { instanceType: 't4g.xlarge' } });
        expect(costs.get(mine.runId)!.machines.usd).toBeCloseTo((20_650.666667 / 14_745) * (0.1344 / 60), 6);

        const down: RuntimeClaimUsageReader = { claimsOfRuns: async () => Promise.reject(new Error('runtime db down')) };
        const unread = (await new RuntimeRunCostService(clock, new InMemoryLlmSpend(), down, { cellPrices }).forRuns([mine])).get(mine.runId)!;
        expect(unread.machines).toMatchObject({ model: 'unknown', usd: null, unpriced: 'missing_claim_facts' });
    });

    it("prices the Runs on the org's own cells at the price per host-hour it set, and leaves them unpriced when it set none or it cannot be read", async () => {
        const r = run({ bootingAt: at(-8), finishedAt: at(0), cellOwner: 'customer' });
        const reader: RuntimeClaimUsageReader = { claimsOfRuns: async (_org, ids) => new Map(ids.map((id) => [id, [claim({ cellId: 'cell-own' })]])) };
        const cells = { listByOrganization: async () => [{ cellId: 'cell-own', organizationId: ORG, owner: 'customer' as const, topology: 'hybrid' as const, status: 'revoked' as const }] };
        const priced = (usdPerHour: number | null) => ({ getOrganization: async () => ({ tokenBudgetPerDay: null, machineUsdPerHostHour: usdPerHour }) });
        const costOf = async (settings: { getOrganization: () => Promise<unknown> }) =>
            (await new RuntimeRunCostService(clock, new InMemoryLlmSpend(), reader, {}, settings as never, cells).forRuns([r])).get(r.runId)!.machines;

        // A cell the org revoked since still prices the Runs it served.
        const machines = await costOf(priced(0.1344));
        expect(machines).toMatchObject({ model: 'shared_cell', paidBy: 'customer', ownHostUsdPerHour: 0.1344 });
        expect(machines.usd).toBeCloseTo((20_650.666667 / 14_745) * (0.1344 / 60), 6);

        expect((await costOf(priced(null))).usd).toBeNull();
        expect((await costOf({ getOrganization: async () => Promise.reject(new Error('db down')) })).usd).toBeNull();
    });
});
