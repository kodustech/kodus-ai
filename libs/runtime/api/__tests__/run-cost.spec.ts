import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import { RuntimeRunCostService } from '../application/run-cost.service';
import { ListRuntimeRunsUseCase } from '../application/use-cases/list-runs.use-case';
import { RuntimeLlmGatewayUseCase } from '../application/use-cases/llm-gateway.use-case';
import { signRunToken } from '../domain/run-token';
import { claimMbMinutes, estimateRunCost, machineMinutesOf, type RunClaimUsage, RUNTIME_MACHINE_LIST_PRICES } from '../domain/run-cost';
import type { RuntimeClaimUsageReader, RuntimeModelPricing } from '../domain/ports';
import { parseCellPrices } from '../infrastructure/runtime-api.config';
import { clock, config, InMemoryLlmUsage, NOW, ORG, REPO, realAuthorization, run, SECRET, storeWith, user } from './fixtures';

// §13 PR 5: the cost of each Run, machines and LLM, as an estimate from list prices.
const SONNET = { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 };
const pricing = (prices: Record<string, typeof SONNET>): RuntimeModelPricing => ({ usdPerToken: async (m) => prices[m] ?? null });
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
    it('ten minutes of two VMs and two observers are about US$ 0.15 at the §11 list prices', () => {
        const cost = estimateRunCost({ run: { bootingAt: at(-10), finishedAt: at(0) }, usage: undefined, prices: new Map(), claims: [ec2('base'), ec2('pr')], cellPriceOf, now: NOW });
        expect(cost.machines).toMatchObject({ model: 'vm', minutes: 10, usd: 0.148267, paidBy: 'kodus', region: 'us-east-1' });
        expect(cost.machines.mbMinutes).toBeUndefined();
        expect(cost.machines.vm).toEqual(RUNTIME_MACHINE_LIST_PRICES.vm);
        expect(cost).toMatchObject({ estimate: true, currency: 'USD', totalUsd: 0.148267, complete: true, llm: { tokens: 0, usd: 0 } });
    });

    it('counts machine time from the boot request, to now while the Run is live, and none before booting', () => {
        expect(machineMinutesOf({ bootingAt: at(-3) }, NOW)).toBe(3);
        expect(machineMinutesOf({ startedAt: at(-2), finishedAt: at(-1) }, NOW)).toBe(1);
        expect(machineMinutesOf({}, NOW)).toBe(0);
        expect(machineMinutesOf({ bootingAt: at(1), finishedAt: at(0) }, NOW)).toBe(0);
    });

    it('prices tokens by model, cache reads and writes at their own rate and off the input once', () => {
        const cost = estimateRunCost({
            run: { bootingAt: at(-10), finishedAt: at(0) },
            claims: [ec2()],
            usage: {
                tokens: 1_000_400,
                byModel: [{ model: 'sonnet', inputTokens: 1_000_000, outputTokens: 400, cacheReadTokens: 600_000, cacheWriteTokens: 100_000 }],
            },
            prices: new Map([['sonnet', SONNET]]),
            now: NOW,
        });
        // 300K uncached × 3 + 600K × 0.3 + 100K × 3.75 + 400 × 15, per million.
        expect(cost.llm.usd).toBe(1.461);
        expect(cost.totalUsd).toBe(1.609267);
        expect(cost.complete).toBe(true);
    });

    it('never invents a price: an unknown model, unsettled tokens or a customer cell leave that part null', () => {
        const unknown = estimateRunCost({
            run: { bootingAt: at(-1), finishedAt: at(0) },
            claims: [ec2()],
            usage: { tokens: 1_500, byModel: [{ model: 'mystery', inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }] },
            prices: new Map([['mystery', null]]),
            now: NOW,
        });
        expect(unknown.llm).toMatchObject({ usd: null, unsettledTokens: 500 });
        expect(unknown.llm.models[0].usd).toBeNull();
        expect(unknown.complete).toBe(false);
        expect(unknown.totalUsd).toBe(unknown.machines.usd);

        const customer = estimateRunCost({
            run: { bootingAt: at(-10), finishedAt: at(0), cellOwner: 'customer' },
            usage: undefined,
            prices: new Map(),
            claims: [ec2()],
            now: NOW,
        });
        expect(customer.machines).toMatchObject({ model: 'vm', minutes: 10, usd: null, paidBy: 'customer' });
        expect(customer.complete).toBe(false);
    });
});

describe('estimateRunCost on a shared cell (docker-gvisor, ADR-070)', () => {
    // kr-shop-like: the Run waited 3 min for room (no claim recorded, nothing held), then the base held its
    // ready size 8 min and the PR its build size 25 s, then its ready size, on a t4g.xlarge with 14 745 MB to commit.
    const shop = [
        claim({ claimId: 'c-base', side: 'base', bootMb: 2_048, readyMb: 2_048, readyAt: at(-7.9) }),
        claim(),
    ];

    it('prices the share of the host each claim held: build size until ready, ready size after; the wait costs nothing', () => {
        const cost = estimateRunCost({
            run: { bootingAt: at(-8), finishedAt: at(0) },
            usage: undefined,
            prices: new Map(),
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
        // The old per-VM price of the same 8 minutes, for scale: 21× more.
        expect(estimateRunCost({ run: { bootingAt: at(-8), finishedAt: at(0) }, usage: undefined, prices: new Map(), claims: [ec2()], now: NOW }).machines.usd).toBe(0.118613);
    });

    it('a claim still open is held until now (never past its ceiling); one that failed and is not released, until it failed', () => {
        expect(claimMbMinutes(claim({ state: 'bound', releasedAt: null, readyAt: at(-1), admittedAt: at(-2) }), NOW)).toBeCloseTo(12_288 + 2_048, 6);
        expect(claimMbMinutes(claim({ state: 'bound', releasedAt: null, readyAt: null, admittedAt: at(-2), hardExpiresAt: at(-1) }), NOW)).toBeCloseTo(12_288, 6);
        expect(claimMbMinutes(claim({ state: 'failed', releasedAt: null, readyAt: null, admittedAt: at(-3), stateChangedAt: at(-1) }), NOW)).toBeCloseTo(2 * 12_288, 6);
    });

    it('a customer cell stays unpriced, with what it held still shown', () => {
        const cost = estimateRunCost({ run: { bootingAt: at(-8), finishedAt: at(0), cellOwner: 'customer' }, usage: undefined, prices: new Map(), claims: shop, cellPriceOf, now: NOW });
        expect(cost.machines).toMatchObject({ model: 'shared_cell', mbMinutes: 37_034.666667, usd: null, paidBy: 'customer' });
        expect(cost.machines.host).toBeUndefined();
        expect(cost.complete).toBe(false);
    });

    it('missing facts are "not priced", never a guessed number', () => {
        const run = { bootingAt: at(-8), finishedAt: at(0) };
        const base = { run, usage: undefined, prices: new Map(), cellPriceOf, now: NOW };
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
    it('the gateway keeps the model and the cache split, and the list prices each Run in one read', async () => {
        const r = run({ state: 'testing', bootingAt: at(-5) });
        const usage = new InMemoryLlmUsage();
        const provider = { complete: async () => ({ text: 'ok', model: 'sonnet', usage: { inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 1_500 } }) };
        const store = await storeWith(r);
        const gateway = new RuntimeLlmGatewayUseCase(store, usage, provider, config(), clock);
        const token = signRunToken(
            {
                runId: r.runId,
                attempt: r.attempt,
                organizationId: ORG,
                teamId: r.teamId,
                repositoryId: REPO,
                prNumber: r.prNumber,
                exp: NOW.getTime() / 1000 + 3_600,
            } as any,
            SECRET,
        );
        await gateway.execute({
            authorization: `Bearer ${token}`,
            body: { runId: r.runId, task: 'runtime.plan', messages: [{ role: 'user', content: 'go' }] },
        });
        expect(usage.rows[0]).toMatchObject({ model: 'sonnet', inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 1_500 });

        let reads = 0;
        const counted = new InMemoryLlmUsage();
        Object.assign(counted, { rows: usage.rows, usageForRuns: (ids: string[]) => (reads++, InMemoryLlmUsage.prototype.usageForRuns.call(counted, ids)) });
        const idle = run({ state: 'queued' });
        const costs = new RuntimeRunCostService(counted, clock, pricing({ sonnet: SONNET }));
        const list = new ListRuntimeRunsUseCase(await storeWith(r, idle), realAuthorization(), costs);
        const rows = await list.execute({ user: user(Role.OWNER), repositoryId: REPO });
        expect(reads).toBe(1);
        const live = rows.find((x) => x.runId === r.runId)!.cost!;
        expect(live.machines.minutes).toBe(5);
        expect(live.llm.models).toEqual([
            { model: 'sonnet', inputTokens: 2_000, outputTokens: 100, cacheReadTokens: 1_500, cacheWriteTokens: 0, usd: 0.00345 },
        ]);
        expect(rows.find((x) => x.runId === idle.runId)!.cost).toMatchObject({ machines: { minutes: 0, usd: 0 }, llm: { tokens: 0 }, totalUsd: 0 });
    });

    it('a price list that fails leaves the LLM part unpriced and the Run still loads', async () => {
        const r = run({ bootingAt: at(-2), finishedAt: at(0) });
        const usage = new InMemoryLlmUsage();
        await usage.record({
            runId: r.runId,
            organizationId: ORG,
            repositoryId: REPO,
            prNumber: 7,
            task: 't',
            inputTokens: 10,
            outputTokens: 5,
            at: NOW,
            ...({ model: 'sonnet' } as any),
        });
        const broken: RuntimeModelPricing = { usdPerToken: async () => Promise.reject(new Error('catalog down')) };
        const claims: RuntimeClaimUsageReader = { claimsOfRuns: async () => new Map([[r.runId, [ec2()]]]) };
        const cost = (await new RuntimeRunCostService(usage, clock, broken, claims).forRuns([r])).get(r.runId)!;
        expect(cost.llm.usd).toBeNull();
        expect(cost.machines.usd).toBeGreaterThan(0);
    });

    it("reads the page's claims once per org and prices a shared cell by RUNTIME_CELL_PRICES; claims that cannot be read leave machines unpriced", async () => {
        const mine = run({ bootingAt: at(-8), finishedAt: at(0) });
        const theirs = run({ organizationId: 'org-other', bootingAt: at(-8), finishedAt: at(0) });
        const asked: Array<[string, string[]]> = [];
        const reader: RuntimeClaimUsageReader = {
            claimsOfRuns: async (org, ids) => (asked.push([org, ids]), new Map(ids.map((id) => [id, [claim()]]))),
        };
        const cellPrices = parseCellPrices('{"cell-dev-1":{"instanceType":"t4g.xlarge","region":"us-east-2"}}');
        const costs = await new RuntimeRunCostService(new InMemoryLlmUsage(), clock, undefined, reader, { cellPrices }).forRuns([mine, theirs]);
        expect(asked).toEqual([
            [ORG, [mine.runId]],
            ['org-other', [theirs.runId]],
        ]);
        expect(costs.get(mine.runId)!.machines).toMatchObject({ model: 'shared_cell', host: { instanceType: 't4g.xlarge' } });
        expect(costs.get(mine.runId)!.machines.usd).toBeCloseTo((20_650.666667 / 14_745) * (0.1344 / 60), 6);

        const down: RuntimeClaimUsageReader = { claimsOfRuns: async () => Promise.reject(new Error('runtime db down')) };
        const unread = (await new RuntimeRunCostService(new InMemoryLlmUsage(), clock, undefined, down, { cellPrices }).forRuns([mine])).get(mine.runId)!;
        expect(unread.machines).toMatchObject({ model: 'unknown', usd: null, unpriced: 'missing_claim_facts' });
    });
});
