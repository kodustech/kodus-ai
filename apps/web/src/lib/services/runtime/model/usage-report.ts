import type {
    RuntimeLlmAgent,
    RuntimeUsageDurationStats,
    RuntimeUsageReport,
    RuntimeUsageRun,
} from "../contracts";

// What the Usage screen says about a month of Kody Runtime usage
// (GET /runtime/settings/usage). A figure the API could not measure is
// "Not measured", never a zero; an estimate says so.

export const NOT_MEASURED = "Not measured";

const MONTH_NAMES = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/** The current UTC month and the `count - 1` before it, newest first. */
export const usageMonthOptions = (now: Date = new Date(), count = 12) =>
    Array.from({ length: count }, (_, i) => {
        const d = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
        );
        const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        return {
            value,
            label: `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        };
    });

const AGENT_LABELS: Record<RuntimeLlmAgent, string> = {
    recipe_author: "Setup file author (setups)",
    planner: "Test planner",
    run_agent: "Run agent",
    intent: "Finding intent",
    setup_learn: "Setup learning",
    other: "Other",
};

export const agentLabel = (agent: RuntimeLlmAgent) =>
    AGENT_LABELS[agent] ?? agent;

const CONSUMER_LABELS: Record<string, string> = {
    runtime: "Runs",
    setup: "Setups",
    sandbox: "Sandbox sessions",
    mcp: "Environment sessions (MCP)",
    custom_agent: "Custom agents",
    unknown: "Older claims",
};

const SIDE_LABELS: Record<string, string> = {
    base: "main",
    pr: "pull request",
    setup: "setup",
};

/** "Runs · main", "Setups", "Sandbox sessions". */
export const consumerLabel = (consumer: string, side: string) => {
    const who = CONSUMER_LABELS[consumer] ?? consumer;
    if (consumer !== "runtime") return who;
    return `${who} · ${SIDE_LABELS[side] ?? side}`;
};

const number = (n: number, digits = 0) =>
    n.toLocaleString("en-US", { maximumFractionDigits: digits });

/** Minutes as "42 min", "1.5 h"; null is not measured. */
export const formatUsageMinutes = (m: number | null | undefined) => {
    if (m == null || !Number.isFinite(m)) return NOT_MEASURED;
    if (m < 1) return m === 0 ? "0 min" : "under 1 min";
    if (m < 120) return `${number(m, 1)} min`;
    return `${number(m / 60, 1)} h`;
};

/** A quantity of machine time: "1,234 GB·min"; null is not measured. */
export const formatUnitMinutes = (
    n: number | null | undefined,
    unit: "GB·min" | "vCPU·min",
) => (n == null ? NOT_MEASURED : `${number(n, n < 10 ? 2 : 0)} ${unit}`);

/** US$ with cents, or a tenth of a cent under a dollar cent; null says why. */
export const formatUsageUsd = (
    usd: number | null | undefined,
    whenNull = "Not priced",
) => {
    if (usd == null || !Number.isFinite(usd)) return whenNull;
    if (usd === 0) return "$0.00";
    if (usd < 0.01) return usd < 0.001 ? "< $0.001" : `$${usd.toFixed(3)}`;
    return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const formatTokens = (n: number) =>
    n >= 1_000_000
        ? `${number(n / 1_000_000, 2)}M`
        : n >= 1_000
          ? `${number(n / 1_000, 1)}K`
          : number(n);

/** p50 / p95 of a duration, and what they cover. */
export const durationLine = (s: RuntimeUsageDurationStats | null) => {
    if (!s) return { value: "n/a", hint: "Not tied to a repository" };
    if (!s.count) return { value: "—", hint: "None this month" };
    return {
        value: `${formatUsageMinutes(s.p50Minutes)} · ${formatUsageMinutes(s.p95Minutes)}`,
        hint: `p50 · p95 over ${s.count}, ${formatUsageMinutes(s.totalMinutes)} in all`,
    };
};

export type UsageTile = { label: string; value: string; hint?: string };

/** The summary strip, in reading order: what ran, how long, on what, and what it cost. */
/** Preview URLs: shown once a preview started this month; its machine time is also in Memory and vCPU. */
const previewTile = (r: RuntimeUsageReport): UsageTile[] => {
    const p = r.previews;
    if (!p || !p.starts) return [];
    const opens =
        p.sessions === null
            ? undefined
            : `${number(p.sessions)} open${p.sessions === 1 ? "" : "s"}`;
    return [
        {
            label: "Previews",
            value: number(p.starts),
            hint: [`${number(Math.round(p.heldMinutes))} machine-min`, opens]
                .filter(Boolean)
                .join(" · "),
        },
    ];
};

export const usageSummaryTiles = (r: RuntimeUsageReport): UsageTile[] => {
    const m = r.machine.total;
    const llm = r.llm.total;
    const runsWall = durationLine(r.wallTime.runs);
    const tiles: UsageTile[] = [
        {
            label: "Runs",
            value: number(r.counts.runs),
            hint:
                r.counts.runsListed < r.counts.runs
                    ? `The table lists the latest ${number(r.counts.runsListed)}`
                    : undefined,
        },
        {
            label: "Setups",
            value: number(r.counts.setups),
            hint: "Each setup boot, repairs included",
        },
        {
            label: "Sandbox sessions",
            value:
                r.counts.sandboxSessions === null
                    ? "n/a"
                    : number(r.counts.sandboxSessions),
            hint:
                r.counts.sandboxSessions === null
                    ? "Not tied to a repository"
                    : undefined,
        },
        sandboxOperationsTile(r),
        ...previewTile(r),
        { label: "Run time", value: runsWall.value, hint: runsWall.hint },
        {
            label: "Memory",
            value: formatUnitMinutes(m.gbMinutes, "GB·min"),
            hint: m.unmeasured.memory
                ? `${m.unmeasured.memory} machine${m.unmeasured.memory === 1 ? "" : "s"} did not report memory`
                : undefined,
        },
        {
            label: "vCPU",
            value: formatUnitMinutes(m.vcpuMinutes, "vCPU·min"),
            hint: m.unmeasured.cpu
                ? `${m.unmeasured.cpu} machine${m.unmeasured.cpu === 1 ? "" : "s"} ran at the host's default size`
                : undefined,
        },
        {
            label: "Build time",
            value: formatUsageMinutes(m.buildMinutes),
            hint: "From asking for a machine until it was ready",
        },
        {
            label: "LLM",
            value:
                r.llm.source === "not_measured" || !llm
                    ? NOT_MEASURED
                    : llm.usd !== null
                      ? formatUsageUsd(llm.usd)
                      : `≥ ${formatUsageUsd(llm.pricedUsd)}`,
            hint:
                r.llm.source === "not_measured" || !llm
                    ? "Token usage is not readable on this deployment"
                    : `${formatTokens(llm.totalTokens)} tokens${llm.customerUsd > 0 ? ` · ${formatUsageUsd(llm.customerUsd)} on your own keys` : ""}${llm.unpricedTokens > 0 ? ` · ${formatTokens(llm.unpricedTokens)} without a price` : ""}`,
        },
        {
            label: "Cost per Run",
            value: r.cost.perRun.perCompleteRun
                ? formatUsageUsd(r.cost.perRun.perCompleteRun.medianUsd)
                : NOT_MEASURED,
            hint: r.cost.perRun.perCompleteRun
                ? `Median over ${r.cost.perRun.completeRuns} priced in full, max ${formatUsageUsd(r.cost.perRun.perCompleteRun.maxUsd)}`
                : "No Run was priced in full",
        },
        {
            label: "Machine cost at your unit price",
            value: r.machine.unitPrices
                ? formatUsageUsd(m.unitUsd, NOT_MEASURED)
                : "No price set",
            hint: r.machine.unitPrices
                ? `$${r.machine.unitPrices.usdPerGbMinute}/GB·min, $${r.machine.unitPrices.usdPerVcpuMinute}/vCPU·min`
                : "No unit price is configured on this deployment",
        },
    ];
    return tiles;
};

/** The sandbox operations of the month: n/a under a filter (a sandbox serves no repository), not measured when unreadable. */
const sandboxOperationsTile = (r: RuntimeUsageReport): UsageTile => {
    const ops = r.counts.sandboxOperations;
    if (r.counts.sandboxSessions === null)
        return {
            label: "Sandbox operations",
            value: "n/a",
            hint: "Not tied to a repository",
        };
    if (!ops)
        return {
            label: "Sandbox operations",
            value: NOT_MEASURED,
            hint: "The sandbox audit is not readable on this deployment",
        };
    const refused = ops.refused + ops.failed;
    return {
        label: "Sandbox operations",
        value: `${number(ops.total)}${ops.partial ? "+" : ""}`,
        hint: refused
            ? `${number(ops.refused)} refused, ${number(ops.failed)} failed`
            : undefined,
    };
};

const START_LABELS: Record<NonNullable<RuntimeUsageRun["start"]>, string> = {
    cold: "Cold build",
    bake: "Bake",
    pool: "Ready pool",
};

/** Where a Run's machines came from: the coldest of them; not measured when its cell did not say. */
export const startLabel = (start: RuntimeUsageRun["start"]) =>
    start ? START_LABELS[start] : NOT_MEASURED;

/** Why a month's figures are partial, in words; empty when they are whole. */
export const usageCaveats = (r: RuntimeUsageReport): string[] => {
    const out: string[] = [];
    if (r.counts.claimsTruncated)
        out.push(
            "This month has more machines than one report reads: machine time is a lower bound.",
        );
    if (r.llm.source === "not_measured")
        out.push("LLM usage is not readable on this deployment.");
    else if ((r.llm.total?.unpricedTokens ?? 0) > 0)
        out.push(
            "Some tokens are from models without a list price; their cost is left out.",
        );
    if (r.machine.total.hostUnpriced > 0)
        out.push(
            `${r.machine.total.hostUnpriced} machine${r.machine.total.hostUnpriced === 1 ? "" : "s"} could not be priced (your own host with no price per host-hour in Runtime settings, or a Kodus host without a list price).`,
        );
    const unsaid = r.runs.filter((run) => run.start === null).length;
    if (unsaid)
        out.push(
            `${unsaid} Run${unsaid === 1 ? "" : "s"} did not say whether ${unsaid === 1 ? "its" : "their"} machines started cold, from the pool or from a bake (a host on an older release).`,
        );
    if (r.counts.sandboxOperations?.partial)
        out.push(
            "The sandbox audit keeps 30 days: this month's sandbox operations are a lower bound.",
        );
    return out;
};

/** The table's boot cell: total, then where it went. */
export const bootLine = (run: RuntimeUsageRun) => {
    if (run.bootMs == null) return NOT_MEASURED;
    const total = `${Math.round(run.bootMs / 1000)} s`;
    if (!run.phaseMs) return total;
    return `${total} (main ${Math.round(run.phaseMs.boot / 1000)} s, PR +${Math.round(run.phaseMs.apply / 1000)} s)`;
};

const TRIGGER_LABELS: Record<string, string> = {
    pull_request: "Pull request",
    comment: "@kody runtime",
    run_again: "Run again",
    simulate: "Simulation",
};

/** What started a Run, as the people who started it call it. */
export const triggerLabel = (trigger: string | null) =>
    trigger ? (TRIGGER_LABELS[trigger] ?? trigger) : "—";

/** Where the organization's Runtime usage lives: the Runtime tab of the Usage screen. */
export const RUNTIME_USAGE_HREF = "/token-usage?tab=runtime";
