import { RuntimeRunCostService } from '../application/run-cost.service';
import { GetRuntimeUsageReportUseCase } from '../application/use-cases/usage-report.use-case';
import { estimateRunCost } from '../domain/run-cost';
import {
    buildUsageReport,
    csvCell,
    durationStats,
    type UsageClaimRecord,
    type UsageReportFilters,
    usageMonthOf,
    usageReportCsv,
    type UsageRunRecord,
} from '../domain/usage-report';
import { loadRuntimeApiConfig } from '../infrastructure/runtime-api.config';
import { ORG, REPO, spendRow } from './fixtures';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const MONTH = usageMonthOf('2026-11')!;
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const T4G = { instanceType: 't4g.xlarge', usdPerHour: 0.1344, region: 'us-east-2' };
const cellPriceOf = (cellId: string) => (cellId === 'cell-dev-1' ? T4G : null);

const runRecord = (patch: Partial<UsageRunRecord> = {}): UsageRunRecord => ({
    runId: 'run-1',
    organizationId: ORG,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    environmentId: 'env-1',
    prNumber: 7,
    trigger: 'pull_request',
    state: 'not_reproduced',
    verdictState: 'final',
    requestedAt: at(-12),
    startedAt: null,
    bootingAt: at(-10),
    finishedAt: at(0),
    cellOwner: 'kodus',
    bootMs: 120_000,
    phaseMs: { boot: 90_000, apply: 30_000 },
    bootPhases: { pr: [{ name: 'compose up', ms: 40_000 }] },
    capacityWaitMs: null,
    ...patch,
});

/** A claim that held 2 GB for 10 minutes (ready after 2), on a priced shared cell. */
const claimRecord = (patch: Partial<UsageClaimRecord> = {}): UsageClaimRecord => ({
    claimId: 'c-1',
    cellId: 'cell-dev-1',
    runId: 'run-1',
    environmentId: 'env-1',
    consumer: 'runtime',
    repositoryId: REPO,
    side: 'pr',
    state: 'released',
    driver: 'docker-gvisor',
    bootMb: 2_048,
    readyMb: 2_048,
    allocatableMb: 14_745,
    cpus: 2,
    admittedAt: at(-10),
    readyAt: at(-8),
    releasedAt: at(0),
    stateChangedAt: at(0),
    hardExpiresAt: at(60),
    createdAt: at(-10),
    ...patch,
});

function report(input: {
    runs?: UsageRunRecord[];
    claims?: UsageClaimRecord[];
    spend?: ReturnType<typeof spendRow>[] | undefined;
    filters?: UsageReportFilters;
    unitPrices?: { usdPerGbMinute: number; usdPerVcpuMinute: number };
    month?: ReturnType<typeof usageMonthOf>;
    sandboxOperations?: { total: number; refused: number; failed: number; durationMs: number };
    previewSessions?: number;
}) {
    const runs = input.runs ?? [runRecord()];
    const claims = input.claims ?? [claimRecord()];
    const spend = 'spend' in input ? input.spend : [spendRow({ usd: 0.5 })];
    const costs = new Map(
        runs.map((r) => [
            r.runId,
            estimateRunCost({
                run: r as never,
                spend: spend?.filter((s) => s.runId === r.runId),
                claims: claims.filter((c) => c.runId === r.runId),
                cellPriceOf,
                now: NOW,
            }),
        ]),
    );
    return buildUsageReport({
        organizationId: ORG,
        month: input.month ?? MONTH,
        filters: input.filters ?? {},
        runs,
        runsTotal: runs.length,
        claims,
        claimsTruncated: false,
        spend,
        costs,
        cellPriceOf,
        ...(input.unitPrices ? { unitPrices: input.unitPrices } : {}),
        ...(input.sandboxOperations ? { sandboxOperations: input.sandboxOperations } : {}),
        ...(input.previewSessions !== undefined ? { previewSessions: input.previewSessions } : {}),
        now: NOW,
    });
}

describe('the Runtime usage report of a month', () => {
    it('counts Runs, setup boots and sandbox sessions, with the wall time of each at p50, p95 and in total', () => {
        const r = report({
            runs: [runRecord(), runRecord({ runId: 'run-2', requestedAt: at(-30), finishedAt: at(0) }), runRecord({ runId: 'run-live', finishedAt: null })],
            claims: [
                claimRecord(),
                claimRecord({ claimId: 's-1', runId: null, consumer: 'setup', side: 'setup', admittedAt: at(-20), releasedAt: at(-5) }),
                claimRecord({ claimId: 'x-1', runId: null, consumer: 'sandbox', environmentId: null, repositoryId: null, admittedAt: at(-3) }),
            ],
        });

        expect(r.counts).toEqual({ runs: 3, runsListed: 3, prs: 1, setups: 1, sandboxSessions: 1, sandboxOperations: null, claimsTruncated: false });
        // A live Run has no wall time yet: 12 and 30 minutes.
        expect(r.wallTime.runs).toEqual({ count: 2, p50Minutes: 12, p95Minutes: 30, totalMinutes: 42 });
        expect(r.wallTime.setups).toMatchObject({ count: 1, totalMinutes: 15 });
        expect(r.wallTime.sandboxSessions).toMatchObject({ count: 1, totalMinutes: 3 });
    });

    it('gives machine time as GB·min and vCPU·min by consumer and side, and counts what a claim did not record instead of a zero', () => {
        const r = report({
            claims: [
                claimRecord(),
                claimRecord({ claimId: 'c-base', side: 'base', cpus: null }),
                claimRecord({ claimId: 'c-ec2', side: 'base', driver: 'aws-ec2', bootMb: null, readyMb: null, allocatableMb: null, cpus: null }),
            ],
        });

        expect(r.machine.byConsumer.find((g) => g.side === 'pr')).toMatchObject({ consumer: 'runtime', claims: 1, gbMinutes: 20, vcpuMinutes: 20, buildMinutes: 2 });
        expect(r.machine.byConsumer.find((g) => g.side === 'base')).toMatchObject({ claims: 2, gbMinutes: 20, vcpuMinutes: null, unmeasured: { memory: 1, cpu: 2 } });
        expect(r.machine.total).toMatchObject({ claims: 3, gbMinutes: 40, vcpuMinutes: 20, unmeasured: { memory: 1, cpu: 2 }, hostUnpriced: 1 });
        // 2 048 MB × 10 min of a 14 745 MB t4g.xlarge, twice.
        expect(r.machine.total.hostUsd).toBeCloseTo(2 * ((20_480 / 14_745) * (0.1344 / 60)), 6);
    });

    it('takes the unit prices from the environment, 0 by default, and nothing that is not a price', () => {
        expect(loadRuntimeApiConfig({}).machineUnitPrices).toEqual({ usdPerGbMinute: 0, usdPerVcpuMinute: 0 });
        expect(loadRuntimeApiConfig({ RUNTIME_MACHINE_USD_PER_GB_MINUTE: '0.0004', RUNTIME_MACHINE_USD_PER_VCPU_MINUTE: '-1' }).machineUnitPrices).toEqual({
            usdPerGbMinute: 0.0004,
            usdPerVcpuMinute: 0,
        });
        expect(loadRuntimeApiConfig({ RUNTIME_MACHINE_USD_PER_GB_MINUTE: 'cheap' }).machineUnitPrices?.usdPerGbMinute).toBe(0);
    });

    it('prices machine time at the unit price only once one is set; the default 0 prices nothing', () => {
        expect(report({}).machine).toMatchObject({ unitPrices: null, total: { unitUsd: null } });
        expect(report({ unitPrices: { usdPerGbMinute: 0, usdPerVcpuMinute: 0 } }).machine.total.unitUsd).toBeNull();
        const priced = report({ unitPrices: { usdPerGbMinute: 0.001, usdPerVcpuMinute: 0.002 } });
        expect(priced.machine.total.unitUsd).toBe(0.06);
        expect(priced.runs[0].machine.unitUsd).toBe(0.06);
    });

    it("splits the LLM by agent with Kodus's and the org's own key apart, and says not measured when the spans cannot be read", () => {
        const r = report({
            spend: [
                spendRow({ agent: 'run_agent', usd: 0.5 }),
                spendRow({ agent: 'planner', usd: 0.25 }),
                spendRow({ runId: 'setup-scope', agent: 'recipe_author', environmentId: 'env-1', paidBy: 'customer', usd: 1 }),
                spendRow({ agent: 'intent', model: 'in-house', usd: null }),
            ],
        });
        expect(r.llm.source).toBe('telemetry');
        expect(r.llm.byAgent.map((a) => [a.agent, a.usd])).toEqual([
            ['recipe_author', 1],
            ['planner', 0.25],
            ['run_agent', 0.5],
            ['intent', null],
        ]);
        expect(r.llm.total).toMatchObject({ usd: null, pricedUsd: 1.75, kodusUsd: 0.75, customerUsd: 1, unpricedTokens: 1_100 });
        expect(r.cost.complete).toBe(false);

        const unread = report({ spend: undefined });
        expect(unread.llm).toEqual({ source: 'not_measured', total: null, byAgent: [] });
        expect(unread.runs[0].llm).toMatchObject({ source: 'not_measured', usd: null });
    });

    it("costs the month to Kodus as the host share of its cells plus the managed LLM, and each Run as the Run page does", () => {
        const r = report({});
        const host = (20_480 / 14_745) * (0.1344 / 60);
        expect(r.cost.kodusUsd).toBeCloseTo(host + 0.5, 6);
        expect(r.cost.complete).toBe(true);
        expect(r.runs[0]).toMatchObject({ machine: { gbMinutes: 20, vcpuMinutes: 20 }, llm: { tokens: 1_100, usd: 0.5 }, complete: true, start: null });
        expect(r.runs[0].totalUsd).toBeCloseTo(host + 0.5, 6);
        expect(r.cost.perRun).toMatchObject({ runs: 1, completeRuns: 1 });
    });

    it("estimates the org's own hosts at its price per host-hour, apart from what the month cost Kodus", () => {
        const own = claimRecord({ claimId: 'c-own', cellId: 'cell-own', consumer: 'setup', runId: null });
        const r = buildUsageReport({
            organizationId: ORG,
            month: MONTH,
            filters: {},
            runs: [],
            runsTotal: 0,
            claims: [claimRecord({ runId: null, consumer: 'setup' }), own],
            claimsTruncated: false,
            spend: [],
            costs: new Map(),
            cellPriceOf,
            ownHostPrice: { usdPerHour: 0.2688, cellIds: new Set(['cell-own']) },
            now: NOW,
        });
        const kodusHost = (20_480 / 14_745) * (0.1344 / 60);
        const ownHost = (20_480 / 14_745) * (0.2688 / 60);
        expect(r.machine.total).toMatchObject({ claims: 2, hostUnpriced: 0 });
        expect(r.machine.total.hostUsd).toBeCloseTo(kodusHost + ownHost, 5);
        expect(r.machine.total.ownHostUsd).toBeCloseTo(ownHost, 5);
        // The org's own host is the org's to pay, never Kodus's.
        expect(r.cost.kodusUsd).toBeCloseTo(kodusHost, 5);

        // Without the price, the org's own host is left out of the estimate, as before.
        const unpriced = report({ claims: [claimRecord(), own] });
        expect(unpriced.machine.total).toMatchObject({ hostUnpriced: 1, ownHostUsd: null });
        expect(unpriced.machine.total.hostUsd).toBeCloseTo(kodusHost, 5);
    });

    it("the report of an org that set its price per host-hour prices its own hosts and each Run on them, with one read of its cells", async () => {
        const own = claimRecord({ cellId: 'cell-own' });
        const reader = {
            runsOfMonth: async () => ({ runs: [runRecord({ cellOwner: 'customer' })], total: 1 }),
            claimsOfMonth: async () => ({ claims: [own], truncated: false }),
            sandboxOperationsOfMonth: async () => ({ total: 0, refused: 0, failed: 0, durationMs: 0 }),
        };
        let cellReads = 0;
        const cells = { listByOrganization: async () => (cellReads++, [{ cellId: 'cell-own', organizationId: ORG, owner: 'customer' as const, topology: 'hybrid' as const, status: 'connected' as const }]) };
        const settings = { getOrganization: async () => ({ tokenBudgetPerDay: null, machineUsdPerHostHour: 0.2688 }) };
        const costs = new RuntimeRunCostService(() => NOW, undefined, undefined, {}, settings, cells);
        const r = await new GetRuntimeUsageReportUseCase(reader, costs, {}, () => NOW).execute({ user: { organization: { uuid: ORG } }, query: { month: '2026-11' } });

        const ownHost = (20_480 / 14_745) * (0.2688 / 60);
        expect(r.machine.total.ownHostUsd).toBeCloseTo(ownHost, 5);
        expect(r.runs[0].machine).toMatchObject({ paidBy: 'customer' });
        expect(r.runs[0].machine.usd).toBeCloseTo(ownHost, 5);
        expect(r.cost.kodusUsd).toBeNull();
        expect(cellReads).toBe(1);
    });

    describe('the e2e suite lines (docs/runtime/e2e-suites.md section 13)', () => {
        const baseReader = {
            runsOfMonth: async () => ({ runs: [], total: 0 }),
            claimsOfMonth: async () => ({ claims: [], truncated: false }),
            sandboxOperationsOfMonth: async () => ({ total: 0, refused: 0, failed: 0, durationMs: 0 }),
        };
        const suiteRows = { rows: [{ mode: 'ci' as const, runs: 3, firstPassMs: 30 * 60_000, rerunMs: 6 * 60_000, withRerun: 1, unmeasured: 0 }], savings: null };
        const costs = () => new RuntimeRunCostService(() => NOW);
        const execute = (suite: unknown, query: Record<string, string> = { month: '2026-11' }) =>
            new GetRuntimeUsageReportUseCase(baseReader as any, costs(), {}, () => NOW, undefined, undefined, suite as any).execute({ user: { organization: { uuid: ORG } }, query });

        it('adds a line per kind with the runs and machine minutes of the month', async () => {
            const r = await execute({ usageOfMonth: async () => suiteRows });
            expect(r.suite?.lines).toEqual([
                { kind: 'pr', runs: 3, minutes: 30 },
                { kind: 'rerun', runs: 1, minutes: 6 },
            ]);
        });

        it('has none under a repository or environment filter (a suite run is the environment\'s, not one repository\'s) and when the suite tables cannot be read', async () => {
            const asked: unknown[] = [];
            const reader = { usageOfMonth: async (...a: unknown[]) => (asked.push(a), suiteRows) };
            expect((await execute(reader, { month: '2026-11', environmentId: 'env-1' })).suite).toBeUndefined();
            expect(asked).toEqual([]);
            expect((await execute({ usageOfMonth: async () => { throw new Error('permission denied for table runtime_suite_runs'); } })).suite).toBeUndefined();
            expect((await execute(undefined)).suite).toBeUndefined();
        });
    });

    it('has a preview row: its starts and held minutes from the preview claims, and the sessions viewers opened', () => {
        const r = report({
            runs: [],
            claims: [
                claimRecord({ claimId: 'p-1', runId: null, consumer: 'preview', side: 'pr', admittedAt: at(-40), releasedAt: at(-15) }),
                claimRecord({ claimId: 'p-2', runId: null, consumer: 'preview', side: 'base', admittedAt: at(-10), releasedAt: at(-5) }),
            ],
            previewSessions: 3,
        });
        expect(r.previews).toEqual({ starts: 2, heldMinutes: 30, sessions: 3 });
        expect(r.machine.byConsumer.map((c) => c.consumer)).toContain('preview');
        // Unreadable activity is "not measured", never zero.
        expect(report({ runs: [], claims: [] }).previews.sessions).toBeNull();
    });

    it('under a repository filter counts only its Runs and setups, and has no sandbox figure', () => {
        const r = report({
            filters: { repositoryId: REPO },
            claims: [claimRecord(), claimRecord({ claimId: 's-1', runId: null, consumer: 'setup', side: 'setup' })],
            spend: [spendRow({ usd: 0.5 }), spendRow({ runId: 'setup-scope', agent: 'recipe_author', usd: 1 }), spendRow({ runId: 'other-repo-run', repositoryId: 'repo-2', usd: 9 })],
        });
        expect(r.counts).toMatchObject({ setups: 1, sandboxSessions: null });
        expect(r.wallTime.sandboxSessions).toBeNull();
        expect(r.llm.total?.usd).toBe(1.5);
    });

    it("says how a Run's machines started: the coldest its claims said, and nothing when none said", () => {
        const r = report({
            runs: [runRecord(), runRecord({ runId: 'run-warm' }), runRecord({ runId: 'run-old' })],
            claims: [
                claimRecord({ side: 'base', start: 'bake' }),
                claimRecord({ claimId: 'c-2', start: 'cold' }),
                claimRecord({ claimId: 'w-1', runId: 'run-warm', side: 'base', start: 'bake' }),
                claimRecord({ claimId: 'w-2', runId: 'run-warm', start: 'pool' }),
                claimRecord({ claimId: 'o-1', runId: 'run-old', start: null }),
            ],
        });
        expect(Object.fromEntries(r.runs.map((x) => [x.runId, x.start]))).toEqual({ 'run-1': 'cold', 'run-warm': 'bake', 'run-old': null });
        expect(usageReportCsv(r)).toContain(',bake,');
    });

    it('counts the sandbox operations of the month, and says when the month reaches past the audit kept', () => {
        const ops = { total: 40, refused: 3, failed: 1, durationMs: 90_000 };
        expect(report({ sandboxOperations: ops }).counts.sandboxOperations).toEqual({ ...ops, partial: false });
        expect(report({ sandboxOperations: ops, month: usageMonthOf('2026-09') }).counts.sandboxOperations).toEqual({ ...ops, partial: true });
        // A sandbox serves no repository, and an audit this deployment cannot read is no figure, never a zero.
        expect(report({ sandboxOperations: ops, filters: { repositoryId: REPO } }).counts.sandboxOperations).toBeNull();
        expect(report({}).counts.sandboxOperations).toBeNull();
    });
});

describe('the usage report price basis and PR counts', () => {
    it('counts the distinct pull requests the Runs belong to, a retry on the same PR counting once, and a Run with no PR not at all', () => {
        const r = report({
            runs: [
                runRecord({ runId: 'a', prNumber: 7 }),
                runRecord({ runId: 'b', prNumber: 7 }),
                runRecord({ runId: 'c', prNumber: 8 }),
                runRecord({ runId: 'd', prNumber: 7, repositoryId: 'other-repo' }),
                runRecord({ runId: 'e', prNumber: null }),
            ],
            claims: [],
        });
        expect(r.counts.prs).toBe(3);
        expect(r.counts.runs).toBe(5);
    });

    it('names the Kodus host the Runs were priced on, with its list price per hour, and the effective US$ per GB·h held', () => {
        const r = report({});
        expect(r.pricing.hosts).toEqual([{ instanceType: 't4g.xlarge', usdPerHour: 0.1344, region: 'us-east-2' }]);
        // 20 GB·min of 2 GB over 10 min = 1/3 GB·h; the Run paid (20480 / 14745) × (0.1344 / 60) US$.
        const usd = (20_480 / 14_745) * (0.1344 / 60);
        expect(r.pricing.effectiveUsdPerGbHour).toBeCloseTo(usd / (20 / 60), 5);
    });

    it('has no host and no effective rate when no Run was priced on a list price, never a zero', () => {
        const r = report({ runs: [runRecord()], claims: [] });
        expect(r.pricing.hosts).toEqual([]);
        expect(r.pricing.effectiveUsdPerGbHour).toBeNull();
    });

    it('lists the models the org used with what it paid per 1M tokens, managed and own key apart, tier tokens kept, and no price for an unpriced model', () => {
        const r = report({
            spend: [
                spendRow({ model: 'model-a', totalTokens: 2_000_000, inputTokens: 1_900_000, outputTokens: 100_000, usd: 4, aboveBaseTierTokens: 500_000 }),
                spendRow({ model: 'model-a', paidBy: 'customer', totalTokens: 1_000_000, usd: 1 }),
                spendRow({ model: 'in-house', totalTokens: 10, usd: null }),
            ],
        });
        expect(r.pricing.llmModels).toEqual([
            expect.objectContaining({ model: 'model-a', paidBy: 'kodus', totalTokens: 2_000_000, aboveBaseTierTokens: 500_000, usdPerMillionTokens: 2 }),
            expect.objectContaining({ model: 'model-a', paidBy: 'customer', usdPerMillionTokens: 1 }),
            expect.objectContaining({ model: 'in-house', usdPerMillionTokens: null }),
        ]);
        expect(report({ spend: undefined }).pricing.llmModels).toEqual([]);
    });
});

describe('the usage report CSV', () => {
    it('writes one line per Run, an empty cell where nothing was measured, and a formula-looking name as text', () => {
        const csv = usageReportCsv(report({ runs: [runRecord({ repositoryName: '=HYPERLINK("x")' })], spend: undefined }));
        const [header, line, end] = csv.split('\r\n');
        const cols = header.split(',');
        expect(end).toBe('');
        const cell = (name: string) => {
            // Split on commas outside quotes.
            const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, ''));
            return cells[cols.indexOf(name)];
        };
        expect(cell('repository')).toBe('"\'=HYPERLINK(""x"")"');
        expect(cell('llm_usd')).toBe('');
        expect(cell('llm_tokens')).toBe('');
        expect(cell('start')).toBe('');
        expect(cell('wall_minutes')).toBe('12');
        expect(cell('pr_boot_phases')).toBe('compose up=40000');
    });

    it('quotes a value with a comma, a quote or a line break', () => {
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
        expect(csvCell(-1.5)).toBe('-1.5');
        expect(csvCell(null)).toBe('');
    });
});

describe('usage months and durations', () => {
    it('a month is YYYY-MM in UTC, from its first instant to the next one', () => {
        expect(usageMonthOf('2026-12')).toEqual({ month: '2026-12', start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
        for (const bad of ['2026-13', '2026-1', '26-11', '2026-11-01', '']) expect(usageMonthOf(bad)).toBeNull();
    });

    it('percentiles are nearest-rank, and nothing is null rather than zero', () => {
        expect(durationStats([])).toEqual({ count: 0, p50Minutes: null, p95Minutes: null, totalMinutes: 0 });
        expect(durationStats(Array.from({ length: 20 }, (_, i) => i + 1))).toMatchObject({ p50Minutes: 10, p95Minutes: 19 });
    });
});
