import { POOL_USD_PER_MACHINE_HOUR } from '../application/pool-controller.service';
import { countPoolUsage } from '../domain/pool';
import { claimHeldMinutes, estimateRunCost, type RunClaimUsage } from '../domain/run-cost';
import { buildUsageReport, type UsageClaimRecord, usageMonthOf, type UsageRunRecord } from '../domain/usage-report';
import { ORG, REPO } from './fixtures';

// Cost audit (machine side, non-LLM): what the Run cost, the usage report and
// the pool spend must count. Each `it.failing` is a defect the audit proved;
// it turns green (and must lose `.failing`) once the defect is fixed.

const NOW = new Date('2026-11-20T12:00:00.000Z');
const at = (min: number, from = NOW) => new Date(from.getTime() + min * 60_000).toISOString();
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** AWS EC2 On-Demand Linux, us-east-1 (instances.vantage.sh, checked 2026-11-12). */
const LIST = { 'm7i.xlarge': 0.2016, 'c7i.large': 0.08925, 't4g.xlarge': 0.1344 } as const;

const ec2Claim = (side: string): RunClaimUsage => ({
    claimId: `c-${side}`,
    cellId: 'cell-aws-1',
    side,
    state: 'released',
    driver: 'aws-ec2',
    bootMb: null,
    readyMb: null,
    allocatableMb: null,
    admittedAt: at(-10),
    readyAt: at(-9),
    releasedAt: at(0),
    stateChangedAt: at(0),
    hardExpiresAt: at(50),
});

describe('machine cost audit: prices', () => {
    it('an aws-ec2 Run is priced at the instances its cell starts: a default workload (4 vCPU, 16 GiB: m7i.xlarge) and an observer (2 vCPU, 4 GiB: c7i.large) per side', () => {
        const cost = estimateRunCost({ run: { bootingAt: at(-10), finishedAt: at(0) }, spend: [], claims: [ec2Claim('base'), ec2Claim('pr')], now: NOW });
        const perHour = 2 * LIST['m7i.xlarge'] + 2 * LIST['c7i.large'];
        expect(cost.machines.usd).toBe(round6((10 / 60) * perHour));
    });

    it('a ready pool machine is priced at most at the instance an aws-ec2 cell starts for it (m7i.xlarge), never above', () => {
        expect(POOL_USD_PER_MACHINE_HOUR).toBeLessThanOrEqual(LIST['m7i.xlarge']);
    });
});

describe('machine cost audit: open intervals', () => {
    // KNOWN DEFECT (cost-audit): an open claim is counted until its hard ceiling, past the lease after which the cell sweeps its machines (lease.go Sweep).
    it.failing('an open claim whose lease ran out holds nothing after its lease: the cell destroys its machines then', () => {
        const claim = {
            claimId: 'c-mcp',
            cellId: 'cell-dev-1',
            side: 'pr',
            state: 'bound',
            driver: 'docker-gvisor',
            bootMb: 2_048,
            readyMb: 2_048,
            allocatableMb: 14_745,
            admittedAt: at(-120),
            readyAt: at(-118),
            releasedAt: null,
            stateChangedAt: at(-118),
            // The worker stopped renewing 90 minutes ago (a crash, a lost release); the ceiling is two hours away.
            leaseExpiresAt: at(-90),
            hardExpiresAt: at(120),
        } as RunClaimUsage & { leaseExpiresAt: string };
        expect(claimHeldMinutes(claim, NOW)).toBe(30);
    });
});

describe('machine cost audit: month totals', () => {
    const MONTH = usageMonthOf('2026-11')!;
    const run: UsageRunRecord = {
        runId: 'run-ec2',
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
        bootMs: null,
        phaseMs: null,
        bootPhases: {},
        capacityWaitMs: null,
    };
    const asRecord = (c: RunClaimUsage): UsageClaimRecord => ({ ...c, runId: run.runId, environmentId: 'env-1', consumer: 'runtime', repositoryId: REPO, createdAt: c.admittedAt! });

    // KNOWN DEFECT (cost-audit): the month's cost to Kodus sums only shared-cell host shares; the aws-ec2 machine cost the Run page prices is left out.
    it.failing("the month's cost to Kodus includes the machine cost of every Kodus Run the Run page priced", () => {
        const claims = [ec2Claim('base'), ec2Claim('pr')];
        const runCost = estimateRunCost({ run, spend: [], claims, now: NOW });
        expect(runCost.machines.usd).toBeGreaterThan(0);
        const report = buildUsageReport({
            organizationId: ORG,
            month: MONTH,
            filters: {},
            runs: [run],
            runsTotal: 1,
            claims: claims.map(asRecord),
            claimsTruncated: false,
            spend: [],
            costs: new Map([[run.runId, runCost]]),
            cellPriceOf: () => null,
            now: NOW,
        });
        expect(report.cost.kodusUsd).toBe(runCost.machines.usd);
    });

    // KNOWN DEFECT (cost-audit): a claim that crosses a month boundary is counted whole in the month its Run was requested (or the claim created), never split.
    it.failing('a month counts only the machine time inside it: a claim from 23:30 on Oct 31 to 00:30 on Nov 1 gives October 30 minutes', () => {
        const october = usageMonthOf('2026-10')!;
        const start = new Date('2026-10-31T23:30:00.000Z');
        const claim: UsageClaimRecord = {
            ...asRecord(ec2Claim('pr')),
            driver: 'docker-gvisor',
            bootMb: 1_024,
            readyMb: 1_024,
            allocatableMb: 14_745,
            admittedAt: at(0, start),
            readyAt: at(1, start),
            releasedAt: at(60, start),
            stateChangedAt: at(60, start),
            hardExpiresAt: at(60, start),
            createdAt: at(0, start),
        };
        const report = buildUsageReport({
            organizationId: ORG,
            month: october,
            filters: {},
            runs: [{ ...run, requestedAt: at(0, start), bootingAt: at(0, start), finishedAt: at(60, start) }],
            runsTotal: 1,
            claims: [claim],
            claimsTruncated: false,
            spend: [],
            costs: new Map(),
            cellPriceOf: () => null,
            now: NOW,
        });
        // 1 GB for the 30 minutes before midnight.
        expect(report.machine.total.gbMinutes).toBe(30);
    });
});

describe('machine cost audit: pool spend', () => {
    // KNOWN DEFECT (cost-audit): the first count of a new month starts it at 0 and drops the machine time since the last count, on both sides of midnight.
    it.failing("the first count of a new month keeps the new month's machine time since midnight", () => {
        const prev = { month: '2026-10', machineMinutes: 100, countedAt: '2026-10-31T23:55:00.000Z' };
        const usage = countPoolUsage(prev, 2, new Date('2026-11-01T00:05:00.000Z'));
        // Two machines kept ready for the 5 minutes after midnight.
        expect(usage).toMatchObject({ month: '2026-11', machineMinutes: 10 });
    });

    // KNOWN DEFECT (cost-audit): while the scheduler is down the cell keeps the pool at its applied size, but the count only adds 15 minutes for the gap.
    it.failing('a gap between two counts counts every minute the cell kept the applied machines ready', () => {
        const prev = { month: '2026-11', machineMinutes: 0, countedAt: '2026-11-20T11:00:00.000Z' };
        expect(countPoolUsage(prev, 2, NOW).machineMinutes).toBe(120);
    });
});
