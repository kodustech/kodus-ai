import { type LlmSpendTotals, RUNTIME_LLM_AGENTS, type RuntimeLlmAgent, type RuntimeLlmSpendRow, sumLlmSpend } from './llm-spend';
import { type CellHostPrice, claimBuildMinutes, claimHeldMinutes, claimMbMinutes, type RunClaimUsage, type RuntimeRunCost, sharedCellCost } from './run-cost';
import { type RunCostSummary, summarizeRunCosts } from './run-cost-summary';

// The Kody Runtime usage report (docs/runtime/usage-report.md): what Runs,
// setups and sandbox sessions of one org used in one UTC month, for pricing.
// Every number comes from a recorded fact; a part with no source is null
// ("not measured") and is never added as zero.

/** Most Runs one report lists; the counts and the machine totals still cover the whole month. */
export const USAGE_REPORT_MAX_RUNS = 2_000;
/** Most claim rows one report reads per kind (the Runs', and the setups' and sessions'). */
export const USAGE_REPORT_MAX_CLAIMS = 20_000;

export interface UsageReportFilters {
    repositoryId?: string;
    environmentId?: string;
}

/** A UTC calendar month: `YYYY-MM`, from its first instant to the next month's. */
export interface UsageMonth {
    month: string;
    start: Date;
    end: Date;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month a `YYYY-MM` names, or null when it is not one. */
export function usageMonthOf(month: string): UsageMonth | null {
    const m = MONTH.exec(month);
    if (!m) return null;
    const year = Number(m[1]);
    const index = Number(m[2]) - 1;
    return { month, start: new Date(Date.UTC(year, index, 1)), end: new Date(Date.UTC(year, index + 1, 1)) };
}

/** The UTC month `now` falls in. */
export function currentUsageMonth(now: Date): UsageMonth {
    return usageMonthOf(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`)!;
}

/** One Run of the month as the projection recorded it. */
export interface UsageRunRecord {
    runId: string;
    organizationId: string;
    repositoryId: string | null;
    repositoryName: string | null;
    environmentId: string | null;
    prNumber: number | null;
    trigger: string | null;
    state: string;
    verdictState: string | null;
    requestedAt: string;
    startedAt: string | null;
    bootingAt: string | null;
    finishedAt: string | null;
    cellOwner: 'kodus' | 'customer' | null;
    bootMs: number | null;
    phaseMs: { boot: number; apply: number } | null;
    /** Each side's boot phases as its cell reported them (claim.ready timing). */
    bootPhases: Partial<Record<'base' | 'pr', Array<{ name: string; ms: number }>>>;
    capacityWaitMs: number | null;
}

/** How a claim's workload came to be, as its cell's claim.ready said (runtime_claims.start_source, migration 24). */
export type UsageClaimStart = 'cold' | 'pool' | 'bake';

/** One claim round with what it served: its consumer, and the Run or the environment's repository. */
export interface UsageClaimRecord extends RunClaimUsage {
    runId: string | null;
    environmentId: string | null;
    /** Consumer (libs/runtime/environment): runtime, setup, sandbox, mcp, custom_agent; `unknown` on rows from before migration 7. */
    consumer: string;
    repositoryId: string | null;
    createdAt: string;
    /** Null when the cell did not say (an older cell, a claim that never got ready, a row from before migration 24). */
    start?: UsageClaimStart | null;
}

/** The org's sandbox operations of the month, as the hub audited them (runtime_sandbox_audit). */
export interface UsageSandboxOperations {
    total: number;
    refused: number;
    failed: number;
    /** Sum of the operations' own durations. */
    durationMs: number;
}

/** Days the Runtime keeps runtime_sandbox_audit (applyRetention in apps/runtime runtime-schema.ts). */
export const SANDBOX_AUDIT_RETENTION_DAYS = 30;

/** The coldest start among a Run's claims that said one: a Run is as warm as its coldest machine. */
const START_ORDER: readonly UsageClaimStart[] = ['cold', 'bake', 'pool'];
export function runStartOf(claims: readonly Pick<UsageClaimRecord, 'start'>[]): UsageClaimStart | null {
    return START_ORDER.find((s) => claims.some((c) => c.start === s)) ?? null;
}

/** A unit price for machine time (RUNTIME_MACHINE_USD_PER_GB_MINUTE / _PER_VCPU_MINUTE); 0 is "not set". */
export interface MachineUnitPrices {
    usdPerGbMinute: number;
    usdPerVcpuMinute: number;
}

export interface DurationStats {
    count: number;
    /** Null when count is 0. */
    p50Minutes: number | null;
    p95Minutes: number | null;
    totalMinutes: number;
}

export interface MachineUsage {
    claims: number;
    /** GB of memory × minutes held (the build size until ready, the ready size after); null when no claim recorded its memory. */
    gbMinutes: number | null;
    /** vCPUs × minutes held; null when no claim recorded its vCPUs (one at the cell's default size records none). */
    vcpuMinutes: number | null;
    /** Minutes from admission until ready (or until the end of a claim that never got ready). */
    buildMinutes: number | null;
    /** Claims whose memory, or vCPUs, are not in gbMinutes, or vcpuMinutes. */
    unmeasured: { memory: number; cpu: number };
    /** The share of a Kodus-managed cell's host the claims held, at its list price (RUNTIME_CELL_PRICES); null when none could be priced. */
    hostUsd: number | null;
    /** Claims the host estimate leaves out (no memory facts, or a cell with no list price). */
    hostUnpriced: number;
    /** gbMinutes × the GB·min price + vcpuMinutes × the vCPU·min price; null when no unit price is set. */
    unitUsd: number | null;
}

export interface UsageReportRun {
    runId: string;
    repositoryId: string | null;
    repositoryName: string | null;
    environmentId: string | null;
    prNumber: number | null;
    trigger: string | null;
    state: string;
    verdict: string | null;
    requestedAt: string;
    finishedAt: string | null;
    /** From the request to the end (null while it runs). */
    wallMinutes: number | null;
    /**
     * Whether the machines came cold, from the pool or from a bake: the coldest
     * its claims said (runStartOf); null when none said (an older cell, rows
     * from before migration 24).
     */
    start: UsageClaimStart | null;
    bootMs: number | null;
    phaseMs: { boot: number; apply: number } | null;
    bootPhases: UsageRunRecord['bootPhases'];
    capacityWaitMs: number | null;
    machine: Omit<MachineUsage, 'hostUsd' | 'hostUnpriced'> & { usd: number | null; paidBy: 'kodus' | 'customer' };
    llm: { tokens: number; usd: number | null; customerUsd: number; source: 'telemetry' | 'not_measured' };
    totalUsd: number | null;
    complete: boolean;
}

export interface UsageReportLlmAgent extends LlmSpendTotals {
    agent: RuntimeLlmAgent;
}

export interface RuntimeUsageReport {
    organizationId: string;
    month: string;
    from: string;
    to: string;
    filters: UsageReportFilters;
    generatedAt: string;
    counts: {
        runs: number;
        /** Runs in `runs` below; fewer than `runs` when the month has more than USAGE_REPORT_MAX_RUNS. */
        runsListed: number;
        /** Setup boots (a repair or a learn boot of a setup counts as its own): the Runtime keeps no row per setup. */
        setups: number;
        /** Null under a repository or environment filter: a sandbox serves neither. */
        sandboxSessions: number | null;
        /**
         * The sandbox operations audited in the month; null under a filter, or
         * when this deployment cannot read the audit. partial: the month starts
         * before the audit's retention, so its oldest operations are gone.
         */
        sandboxOperations: (UsageSandboxOperations & { partial: boolean }) | null;
        /** Some claim rows were left out at USAGE_REPORT_MAX_CLAIMS: the machine totals are a lower bound. */
        claimsTruncated: boolean;
    };
    /**
     * Preview URLs (docs/runtime/preview-urls.md §5.4): each start of a preview
     * is one claim of consumer preview; its machine time is also in
     * machine.byConsumer. sessions: viewers who opened one (null under a
     * filter, or when the preview activity cannot be read here).
     */
    previews: { starts: number; heldMinutes: number; sessions: number | null };
    wallTime: { runs: DurationStats; setups: DurationStats; sandboxSessions: DurationStats | null };
    machine: {
        total: MachineUsage;
        /** By consumer and side, largest first. */
        byConsumer: Array<MachineUsage & { consumer: string; side: string }>;
        unitPrices: MachineUnitPrices | null;
    };
    llm: {
        /** `telemetry`: the usage spans; `not_measured`: this deployment cannot read them (every figure below is null). */
        source: 'telemetry' | 'not_measured';
        total: LlmSpendTotals | null;
        byAgent: UsageReportLlmAgent[];
    };
    cost: {
        /** The cost per Run, over the Runs priced in full (run-cost-summary.ts). */
        perRun: RunCostSummary;
        /**
         * What the month cost Kodus, as an estimate: the host share of every
         * claim on a Kodus-managed cell plus the LLM Kodus pays (managed
         * models). Null when neither part could be priced.
         */
        kodusUsd: number | null;
        /** False when a part is missing from kodusUsd (unpriced claims, unpriced tokens, spans not readable). */
        complete: boolean;
    };
    runs: UsageReportRun[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round3 = (n: number) => Math.round(n * 1e3) / 1e3;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: number[], p: number): number | null {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function durationStats(minutes: readonly number[]): DurationStats {
    const sorted = minutes.filter((m) => Number.isFinite(m) && m >= 0).sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    return {
        count: sorted.length,
        p50Minutes: p50 === null ? null : round3(p50),
        p95Minutes: p95 === null ? null : round3(p95),
        totalMinutes: round3(sorted.reduce((n, m) => n + m, 0)),
    };
}

const unitPricesOf = (p: MachineUnitPrices | undefined): MachineUnitPrices | null => (p && (p.usdPerGbMinute > 0 || p.usdPerVcpuMinute > 0) ? p : null);

/** The machine time of a set of claim rounds, and what it cost where it can be priced. */
export function machineUsageOf(claims: readonly RunClaimUsage[], opts: { now: Date; cellPriceOf: (cellId: string) => CellHostPrice | null; unitPrices: MachineUnitPrices | null }): MachineUsage {
    let gb = 0;
    let vcpu = 0;
    let build = 0;
    let host = 0;
    let gbMeasured = 0;
    let cpuMeasured = 0;
    let buildMeasured = 0;
    let hostPriced = 0;
    for (const c of claims) {
        const mbMinutes = claimMbMinutes(c, opts.now);
        if (mbMinutes !== null) {
            gb += mbMinutes / 1024;
            gbMeasured++;
        }
        const held = claimHeldMinutes(c, opts.now);
        if (held !== null && c.cpus) {
            vcpu += c.cpus * held;
            cpuMeasured++;
        }
        const built = claimBuildMinutes(c, opts.now);
        if (built !== null) {
            build += built;
            buildMeasured++;
        }
        const shared = sharedCellCost([c], opts.cellPriceOf, opts.now);
        if (shared.usd !== null) {
            host += shared.usd;
            hostPriced++;
        }
    }
    const gbMinutes = gbMeasured ? round3(gb) : null;
    const vcpuMinutes = cpuMeasured ? round3(vcpu) : null;
    const p = opts.unitPrices;
    const unitUsd = p && (gbMinutes !== null || vcpuMinutes !== null) ? round6((gbMinutes ?? 0) * p.usdPerGbMinute + (vcpuMinutes ?? 0) * p.usdPerVcpuMinute) : null;
    return {
        claims: claims.length,
        gbMinutes,
        vcpuMinutes,
        buildMinutes: buildMeasured ? round3(build) : null,
        unmeasured: { memory: claims.length - gbMeasured, cpu: claims.length - cpuMeasured },
        hostUsd: hostPriced ? round6(host) : null,
        hostUnpriced: claims.length - hostPriced,
        unitUsd,
    };
}

/** The Runtime's spans that belong to the filtered place: a listed Run's, or a setup's of that repository or environment. */
function spendOfPlace(rows: readonly RuntimeLlmSpendRow[], filters: UsageReportFilters, runIds: ReadonlySet<string>): RuntimeLlmSpendRow[] {
    if (!filters.repositoryId && !filters.environmentId) return [...rows];
    return rows.filter((r) => {
        if (r.runId && runIds.has(r.runId)) return true;
        const repo = filters.repositoryId ? r.repositoryId === filters.repositoryId : true;
        const env = filters.environmentId ? r.environmentId === filters.environmentId : true;
        return repo && env && (!!r.repositoryId || !!r.environmentId);
    });
}

export function buildUsageReport(input: {
    organizationId: string;
    month: UsageMonth;
    filters: UsageReportFilters;
    runs: readonly UsageRunRecord[];
    /** Every Run of the month under the filters, listed or not. */
    runsTotal: number;
    /** The claims of the month's Runs (consumer runtime) and the other claims created in the month. */
    claims: readonly UsageClaimRecord[];
    claimsTruncated: boolean;
    /** The org's priced Runtime spans of the month; undefined when they cannot be read. */
    spend: readonly RuntimeLlmSpendRow[] | undefined;
    /** The org's sandbox operations of the month; undefined when the audit cannot be read. */
    sandboxOperations?: UsageSandboxOperations;
    /** Preview sessions opened in the month; undefined when the preview activity cannot be read. */
    previewSessions?: number;
    /** Each listed Run's cost, as the Run page shows it. */
    costs: ReadonlyMap<string, RuntimeRunCost>;
    cellPriceOf: (cellId: string) => CellHostPrice | null;
    unitPrices?: MachineUnitPrices;
    now: Date;
}): RuntimeUsageReport {
    const { now, filters } = input;
    const unitPrices = unitPricesOf(input.unitPrices);
    const usage = (claims: readonly RunClaimUsage[]) => machineUsageOf(claims, { now, cellPriceOf: input.cellPriceOf, unitPrices });
    const filtered = !!(filters.repositoryId || filters.environmentId);

    const of = (consumer: string) => input.claims.filter((c) => c.consumer === consumer);
    const setups = of('setup');
    const sandboxes = of('sandbox');
    const previews = of('preview');
    const held = (cs: readonly RunClaimUsage[]) => cs.map((c) => claimHeldMinutes(c, now)).filter((m): m is number => m !== null);

    const groups = new Map<string, UsageClaimRecord[]>();
    for (const c of input.claims) {
        const key = `${c.consumer}\u0000${c.side}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const byConsumer = [...groups.entries()]
        .map(([key, cs]) => {
            const [consumer, side] = key.split('\u0000');
            return { consumer, side, ...usage(cs) };
        })
        .sort((a, b) => (b.gbMinutes ?? 0) - (a.gbMinutes ?? 0) || b.claims - a.claims);
    const total = usage(input.claims);

    const claimsOfRun = new Map<string, UsageClaimRecord[]>();
    for (const c of input.claims) if (c.runId && c.consumer === 'runtime') claimsOfRun.set(c.runId, [...(claimsOfRun.get(c.runId) ?? []), c]);

    const runs: UsageReportRun[] = input.runs.map((r) => {
        const cost = input.costs.get(r.runId);
        const m = usage(claimsOfRun.get(r.runId) ?? []);
        const wall = r.finishedAt ? (ms(r.finishedAt) - ms(r.requestedAt)) / 60_000 : NaN;
        return {
            runId: r.runId,
            repositoryId: r.repositoryId,
            repositoryName: r.repositoryName,
            environmentId: r.environmentId,
            prNumber: r.prNumber,
            trigger: r.trigger,
            state: r.state,
            verdict: r.verdictState,
            requestedAt: r.requestedAt,
            finishedAt: r.finishedAt,
            wallMinutes: Number.isFinite(wall) && wall >= 0 ? round3(wall) : null,
            start: runStartOf(claimsOfRun.get(r.runId) ?? []),
            bootMs: r.bootMs,
            phaseMs: r.phaseMs,
            bootPhases: r.bootPhases,
            capacityWaitMs: r.capacityWaitMs,
            machine: {
                claims: m.claims,
                gbMinutes: m.gbMinutes,
                vcpuMinutes: m.vcpuMinutes,
                buildMinutes: m.buildMinutes,
                unmeasured: m.unmeasured,
                unitUsd: m.unitUsd,
                usd: cost?.machines.usd ?? null,
                paidBy: cost?.machines.paidBy ?? (r.cellOwner === 'customer' ? 'customer' : 'kodus'),
            },
            llm: cost
                ? { tokens: cost.llm.tokens, usd: cost.llm.usd, customerUsd: cost.llm.customerUsd ?? 0, source: cost.llm.source }
                : { tokens: 0, usd: null, customerUsd: 0, source: 'not_measured' },
            totalUsd: cost?.totalUsd ?? null,
            complete: cost?.complete ?? false,
        };
    });

    const runIds = new Set<string>([...input.runs.map((r) => r.runId), ...[...claimsOfRun.keys()]]);
    const spend = input.spend ? spendOfPlace(input.spend, filters, runIds) : undefined;
    const llmTotal = spend ? sumLlmSpend(spend) : null;
    const byAgent: UsageReportLlmAgent[] = spend
        ? RUNTIME_LLM_AGENTS.map((agent) => ({ agent, ...sumLlmSpend(spend.filter((r) => r.agent === agent)) })).filter((a) => a.totalTokens > 0)
        : [];

    // The month's cost to Kodus: host shares of Kodus-managed cells and the managed LLM, each a lower bound while a part is unpriced.
    const parts = [total.hostUsd, llmTotal ? llmTotal.kodusUsd : null];
    const kodusUsd = parts.every((p) => p === null) ? null : round6(parts.reduce<number>((n, p) => n + (p ?? 0), 0));
    const costComplete = total.hostUnpriced === 0 && !!llmTotal && llmTotal.unpricedTokens === 0;

    return {
        organizationId: input.organizationId,
        month: input.month.month,
        from: input.month.start.toISOString(),
        to: input.month.end.toISOString(),
        filters,
        generatedAt: now.toISOString(),
        counts: {
            runs: input.runsTotal,
            runsListed: runs.length,
            setups: setups.length,
            sandboxSessions: filtered ? null : sandboxes.length,
            sandboxOperations:
                filtered || !input.sandboxOperations
                    ? null
                    : { ...input.sandboxOperations, partial: input.month.start.getTime() < now.getTime() - SANDBOX_AUDIT_RETENTION_DAYS * 86_400_000 },
            claimsTruncated: input.claimsTruncated,
        },
        previews: {
            starts: previews.length,
            heldMinutes: round3(held(previews).reduce((n, m) => n + m, 0)),
            sessions: filtered || input.previewSessions === undefined ? null : input.previewSessions,
        },
        wallTime: {
            runs: durationStats(runs.map((r) => r.wallMinutes).filter((m): m is number => m !== null)),
            setups: durationStats(held(setups)),
            sandboxSessions: filtered ? null : durationStats(held(sandboxes)),
        },
        machine: { total, byConsumer, unitPrices },
        llm: { source: spend ? 'telemetry' : 'not_measured', total: llmTotal, byAgent },
        cost: { perRun: summarizeRunCosts([...input.costs.values()]), kodusUsd, complete: costComplete },
        runs,
    };
}

// ── CSV ───────────────────────────────────────────────────────────────────

/** The per-Run CSV's columns, in order. An empty cell is "not measured" (docs/runtime/usage-report.md). */
export const USAGE_CSV_COLUMNS = [
    'run_id',
    'requested_at',
    'finished_at',
    'repository',
    'repository_id',
    'environment_id',
    'pr_number',
    'trigger',
    'state',
    'verdict',
    'start',
    'wall_minutes',
    'capacity_wait_ms',
    'boot_ms',
    'boot_phase_ms',
    'apply_phase_ms',
    'base_boot_phases',
    'pr_boot_phases',
    'gb_minutes',
    'vcpu_minutes',
    'build_minutes',
    'machine_usd_estimate',
    'machine_usd_at_unit_price',
    'machine_paid_by',
    'llm_tokens',
    'llm_usd',
    'llm_usd_paid_by_org',
    'total_usd',
    'complete',
] as const;

/**
 * One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line
 * break. A value a spreadsheet would run as a formula (=, +, -, @, tab, CR at
 * the start: a repository name is the user's) is prefixed with a quote.
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const phasesCell = (phases: Array<{ name: string; ms: number }> | undefined) => (phases?.length ? phases.map((p) => `${p.name}=${p.ms}`).join('; ') : null);

/** The report's Runs as CSV, one line per Run, CRLF line ends, a header first. */
export function usageReportCsv(report: RuntimeUsageReport): string {
    const lines = [USAGE_CSV_COLUMNS.join(',')];
    for (const r of report.runs) {
        const row: Record<(typeof USAGE_CSV_COLUMNS)[number], string | number | boolean | null> = {
            run_id: r.runId,
            requested_at: r.requestedAt,
            finished_at: r.finishedAt,
            repository: r.repositoryName,
            repository_id: r.repositoryId,
            environment_id: r.environmentId,
            pr_number: r.prNumber,
            trigger: r.trigger,
            state: r.state,
            verdict: r.verdict,
            start: r.start,
            wall_minutes: r.wallMinutes,
            capacity_wait_ms: r.capacityWaitMs,
            boot_ms: r.bootMs,
            boot_phase_ms: r.phaseMs?.boot ?? null,
            apply_phase_ms: r.phaseMs?.apply ?? null,
            base_boot_phases: phasesCell(r.bootPhases.base),
            pr_boot_phases: phasesCell(r.bootPhases.pr),
            gb_minutes: r.machine.gbMinutes,
            vcpu_minutes: r.machine.vcpuMinutes,
            build_minutes: r.machine.buildMinutes,
            machine_usd_estimate: r.machine.usd,
            machine_usd_at_unit_price: r.machine.unitUsd,
            machine_paid_by: r.machine.paidBy,
            llm_tokens: r.llm.source === 'telemetry' ? r.llm.tokens : null,
            llm_usd: r.llm.usd,
            llm_usd_paid_by_org: r.llm.source === 'telemetry' ? r.llm.customerUsd : null,
            total_usd: r.totalUsd,
            complete: r.complete,
        };
        lines.push(USAGE_CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}
