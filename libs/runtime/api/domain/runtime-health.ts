import { classifyBlocker } from '@libs/runtime/blockers/catalog';
import {
    type CellSessionView,
    type ClaimRowView,
    type RunRow,
    type SetupRow,
    type StuckItem,
    stuckCells,
    stuckClaims,
    stuckRuns,
    stuckSetups,
} from '@libs/runtime/health/stuck';

import { durationStats } from './usage-report';
import { type RuntimeLlmSpendRow, sumLlmSpend } from './llm-spend';
import { claimHeldMinutes, claimMbMinutes, ownCellPriceOf, type RunClaimUsage, sharedCellCost } from './run-cost';

// Kody Runtime → Settings → Health (docs/runtime/observability.md "The Health
// screen"): what an org owner checks first, from the sources the Runtime
// already keeps (the Run projection, the setups, the claims, the cells, the
// usage spans) and the hang detector's own rule. A figure whose source this
// deployment cannot read is null with the reason, never a zero.

export type NotMeasured = { measured: false; reason: string };
export type Measured<T> = ({ measured: true } & T) | NotMeasured;

const notMeasured = (reason: string): NotMeasured => ({ measured: false, reason });

export interface HealthRun {
    runId: string;
    state: string;
    verdictState: string | null;
    requestedAt: string;
    bootMs: number | null;
}

export interface HealthBlocker {
    kind: string;
    signature: string;
    message: string;
    at: string;
    environmentId?: string | null;
    runId?: string | null;
    source: 'setup' | 'run';
}

export interface HealthCell {
    cellId: string;
    owner: 'kodus' | 'customer';
    status: string;
    connected: boolean;
    lastHeartbeatAt: string | null;
    freeSlots: number | null;
    isolation: string | null;
    driver: string | null;
    maxClaimMemoryMb: number | null;
    maxClaimCpus: number | null;
}

export interface RuntimeHealthInput {
    organizationId: string;
    now: Date;
    /** The org's setups, every state (one row per environment). */
    setups: SetupRow[] | undefined;
    /** Runs requested in the last 14 days. */
    runs: HealthRun[] | undefined;
    /** The org's live Runs (for the hang rule). */
    liveRuns: RunRow[] | undefined;
    openClaims: ClaimRowView[] | undefined;
    blockers: HealthBlocker[] | undefined;
    /** The cells the org owns (customer cells); Kodus's shared cells are not the org's to see. */
    cells: HealthCell[] | undefined;
    sessions: CellSessionView[] | undefined;
    /** Today's (UTC) claims and usage spans, for today's cost. */
    claimsToday: RunClaimUsage[] | undefined;
    spendToday: RuntimeLlmSpendRow[] | undefined;
    unitPrices?: { usdPerGbMinute: number; usdPerVcpuMinute: number } | null;
    /** The org's price per host-hour of its own hosts (Runtime settings); null or absent: its cells are priced as the others. */
    ownHostUsdPerHour?: number | null;
}

export interface RuntimeHealthStuck extends StuckItem {
    /** Where the product shows it: the Run page or the environment's health. */
    link: { kind: 'run'; runId: string } | { kind: 'environment'; environmentId: string } | { kind: 'cell'; cellId: string } | { kind: 'none' };
}

export interface RuntimeHealth {
    organizationId: string;
    at: string;
    summary: {
        setups: Measured<{ active: number; blocked: number; settingUp: number }>;
        runs: Measured<{ days: number; total: number; byVerdict: Record<string, number> }>;
        boot: Measured<{ thisWeek: { count: number; p50Ms: number | null; p95Ms: number | null }; lastWeek: { count: number; p50Ms: number | null; p95Ms: number | null }; trend: 'faster' | 'slower' | 'same' | 'no_data' }>;
    };
    stuck: Measured<{ items: RuntimeHealthStuck[]; notChecked: string[] }>;
    errors: Measured<{ days: number; bySignature: Array<{ signature: string; kind: string; title: string; count: number; lastAt: string; environmentId?: string; runId?: string }> }>;
    cells: Measured<{ items: HealthCell[]; pool: NotMeasured }>;
    cost: {
        today: Measured<{
            llmUsd: number | null;
            machineUsd: number | null;
            totalUsd: number | null;
            complete: boolean;
            gbMinutes: number | null;
            vcpuMinutes: number | null;
            /** The org's price per host-hour that priced the claims on its own cells today; null when none did (absent from an older API). */
            ownHostUsdPerHour?: number | null;
        }>;
        usagePath: string;
    };
}

const DAY = 86_400_000;
/** Six decimals, as the usage report's US$. */
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const UNREADABLE = 'The Runtime database is not readable from here (RUNTIME_DATABASE_READ_URL).';

function bootWeek(runs: HealthRun[], from: number, to: number) {
    const ms = runs.filter((r) => r.bootMs !== null && Date.parse(r.requestedAt) >= from && Date.parse(r.requestedAt) < to).map((r) => r.bootMs! / 60_000);
    const s = durationStats(ms);
    return { count: s.count, p50Ms: s.p50Minutes === null ? null : Math.round(s.p50Minutes * 60_000), p95Ms: s.p95Minutes === null ? null : Math.round(s.p95Minutes * 60_000) };
}

/** A week's p95 against the one before: more than 10 % apart is a change, else the same. */
function trendOf(a: { p95Ms: number | null }, b: { p95Ms: number | null }): 'faster' | 'slower' | 'same' | 'no_data' {
    if (a.p95Ms === null || b.p95Ms === null || b.p95Ms === 0) return 'no_data';
    const r = a.p95Ms / b.p95Ms;
    return r > 1.1 ? 'slower' : r < 0.9 ? 'faster' : 'same';
}

const linkOf = (i: StuckItem): RuntimeHealthStuck['link'] =>
    i.runId ? { kind: 'run', runId: i.runId } : i.environmentId ? { kind: 'environment', environmentId: i.environmentId } : i.cellId ? { kind: 'cell', cellId: i.cellId } : { kind: 'none' };

type UnitUsage = { gb: number; cpu: number; gbMeasured: boolean; cpuMeasured: boolean };

/** GB·min and vCPU·min the claims held, and whether any claim recorded each. */
function unitUsage(claims: readonly RunClaimUsage[], now: Date): UnitUsage {
    const u: UnitUsage = { gb: 0, cpu: 0, gbMeasured: false, cpuMeasured: false };
    for (const c of claims) {
        const mb = claimMbMinutes(c, now);
        if (mb !== null) {
            u.gb += mb / 1024;
            u.gbMeasured = true;
        }
        const held = claimHeldMinutes(c, now);
        if (held !== null && c.cpus) {
            u.cpu += held * c.cpus;
            u.cpuMeasured = true;
        }
    }
    return u;
}

export function buildRuntimeHealth(input: RuntimeHealthInput): RuntimeHealth {
    const now = input.now.getTime();
    const { setups, runs } = input;

    const setupSummary = setups
        ? { measured: true as const, active: setups.filter((s) => s.state === 'active').length, blocked: setups.filter((s) => s.state === 'blocked').length, settingUp: setups.filter((s) => s.state === 'setting_up').length }
        : notMeasured(UNREADABLE);

    const week = runs?.filter((r) => Date.parse(r.requestedAt) >= now - 7 * DAY);
    const byVerdict: Record<string, number> = {};
    for (const r of week ?? []) {
        const v = r.verdictState ?? r.state;
        byVerdict[v] = (byVerdict[v] ?? 0) + 1;
    }
    const thisWeek = runs ? bootWeek(runs, now - 7 * DAY, now + 1) : undefined;
    const lastWeek = runs ? bootWeek(runs, now - 14 * DAY, now - 7 * DAY) : undefined;

    const notChecked = ['admission requests', 'DBOS workflows'];
    const stuckReadable = input.liveRuns && setups && input.openClaims && input.sessions;
    const items = stuckReadable
        ? [...stuckRuns(input.liveRuns!, input.now), ...stuckSetups(setups!, input.now), ...stuckClaims(input.openClaims!, input.now), ...stuckCells(input.sessions!, input.now)]
              .filter((i) => i.subject !== 'setup_queue')
              .map((i) => ({ ...i, link: linkOf(i) }))
              .sort((a, b) => b.ageMs - a.ageMs)
        : undefined;

    const groups = new Map<string, { signature: string; kind: string; title: string; count: number; lastAt: string; environmentId?: string; runId?: string }>();
    for (const b of input.blockers ?? []) {
        const g = groups.get(b.signature);
        const newer = !g || Date.parse(b.at) > Date.parse(g.lastAt);
        const title = g?.title ?? classifyBlocker({ kind: b.kind, signature: b.signature, message: b.message }).title;
        groups.set(b.signature, {
            signature: b.signature,
            kind: b.kind,
            title,
            count: (g?.count ?? 0) + 1,
            lastAt: newer ? b.at : g!.lastAt,
            ...(newer ? { ...(b.environmentId ? { environmentId: b.environmentId } : {}), ...(b.runId ? { runId: b.runId } : {}) } : { ...(g?.environmentId ? { environmentId: g.environmentId } : {}), ...(g?.runId ? { runId: g.runId } : {}) }),
        });
    }

    const live = new Map((input.sessions ?? []).map((s) => [s.cellId, s]));

    let today: RuntimeHealth['cost']['today'] = notMeasured(UNREADABLE);
    if (input.claimsToday) {
        const usage = unitUsage(input.claimsToday, input.now);
        const p = input.unitPrices && (input.unitPrices.usdPerGbMinute > 0 || input.unitPrices.usdPerVcpuMinute > 0) ? input.unitPrices : null;
        const unitUsd = (u: UnitUsage) => (p && (u.gbMeasured || u.cpuMeasured) ? u.gb * p.usdPerGbMinute + u.cpu * p.usdPerVcpuMinute : null);
        // The claims on the org's own cells, at the price per host-hour it set (the share of the host each held);
        // the others at the unit prices, as before. Its cells unreadable or no price: every claim as before.
        const own = input.ownHostUsdPerHour && input.cells ? { usdPerHour: input.ownHostUsdPerHour, cellIds: new Set(input.cells.filter((c) => c.owner === 'customer').map((c) => c.cellId)) } : undefined;
        const onOwn = own ? input.claimsToday.filter((c) => own.cellIds.has(c.cellId)) : [];
        let machineUsd: number | null;
        if (own && onOwn.length) {
            const ownUsd = sharedCellCost(onOwn, ownCellPriceOf(own), input.now).usd;
            const others = input.claimsToday.filter((c) => !own.cellIds.has(c.cellId));
            const othersUsd = others.length ? unitUsd(unitUsage(others, input.now)) : 0;
            machineUsd = ownUsd !== null && othersUsd !== null ? round6(ownUsd + othersUsd) : null;
        } else {
            const u = unitUsd(usage);
            machineUsd = u === null ? null : round6(u);
        }
        const llm = input.spendToday ? sumLlmSpend(input.spendToday) : undefined;
        const llmUsd = llm ? llm.usd : null;
        today = {
            measured: true,
            llmUsd,
            machineUsd,
            totalUsd: llmUsd !== null && machineUsd !== null ? round6(llmUsd + machineUsd) : null,
            complete: llmUsd !== null && machineUsd !== null,
            gbMinutes: usage.gbMeasured ? Math.round(usage.gb * 1000) / 1000 : null,
            vcpuMinutes: usage.cpuMeasured ? Math.round(usage.cpu * 1000) / 1000 : null,
            ownHostUsdPerHour: own && onOwn.length && machineUsd !== null ? own.usdPerHour : null,
        };
    }

    return {
        organizationId: input.organizationId,
        at: input.now.toISOString(),
        summary: {
            setups: setupSummary,
            runs: week ? { measured: true, days: 7, total: week.length, byVerdict } : notMeasured(UNREADABLE),
            boot: thisWeek && lastWeek ? { measured: true, thisWeek, lastWeek, trend: trendOf(thisWeek, lastWeek) } : notMeasured(UNREADABLE),
        },
        stuck: items ? { measured: true, items, notChecked } : notMeasured(UNREADABLE),
        errors: input.blockers ? { measured: true, days: 7, bySignature: [...groups.values()].sort((a, b) => b.count - a.count) } : notMeasured(UNREADABLE),
        cells: input.cells
            ? {
                  measured: true,
                  items: input.cells.map((c) => {
                      const s = live.get(c.cellId);
                      return { ...c, connected: !!s && !s.disconnectedAt, lastHeartbeatAt: s?.lastHeartbeatAt ?? c.lastHeartbeatAt };
                  }),
                  pool: notMeasured('The host keeps its warm pool count to itself (cell_pool_ready); the Runtime database does not record it.'),
              }
            : notMeasured(UNREADABLE),
        cost: { today, usagePath: '/runtime/settings/usage' },
    };
}
