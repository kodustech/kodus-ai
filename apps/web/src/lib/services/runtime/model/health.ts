// What the Health screen (Kody Runtime → Settings → Health) says, in the
// owner's words: pure and tested. The figures come from GET
// /runtime/settings/health; a figure the API could not read says "Not
// measured" with its reason, never a zero (docs/runtime/observability.md).

import type { RuntimeHealth, RuntimeHealthStuck } from "../contracts";
import { formatDurationMs } from "../format";
import { runStateLabel, type Tone } from "../labels";
import { CELLS_SECTION_ID } from "./blockers";

export const HEALTH_NOT_MEASURED = "Not measured";

const SUBJECT: Record<RuntimeHealthStuck["subject"], string> = {
    run: "Run",
    setup: "Environment setup",
    setup_queue: "Setup queue",
    claim: "Machine",
    sandbox: "Code sandbox",
    admission: "Admission request",
    workflow: "Workflow",
    cell: "Host",
};

const STATE: Record<string, string> = {
    queued: "waiting in the queue",
    awaiting_approval: "waiting for a maintainer's approval",
    booting: "starting its machines",
    testing: "testing",
    setting_up: "setting up",
    no_progress: "with no progress",
    pending: "starting",
    bound: "holding its machine",
    held: "kept for diagnosis",
    blocked: "blocked and not let go",
    failed: "failed and not let go",
    compromised: "kept as evidence",
    connected_silent: "connected but silent",
};

export const stuckSubjectLabel = (s: RuntimeHealthStuck["subject"]) =>
    SUBJECT[s] ?? s;
export const stuckStateLabel = (state: string) => STATE[state] ?? state;

/**
 * One line per stuck item: what, in which state, for how long, and the
 * longest that state should last. A machine past its hard limit has no
 * "should take": it says how long past the limit it is.
 */
export function stuckLine(i: RuntimeHealthStuck): string {
    const what = `${stuckSubjectLabel(i.subject)} ${stuckStateLabel(i.state)}`;
    if (i.boundMs === 0)
        return `${what}, ${formatDurationMs(i.ageMs)} past its hard time limit`;
    return `${what} for ${formatDurationMs(i.ageMs)}; it should take at most ${formatDurationMs(i.boundMs)}`;
}

/** Where the product shows a stuck item: the Run page, the environment, or the cells list. */
export function stuckHref(i: RuntimeHealthStuck): string | undefined {
    if (i.link.kind === "run")
        return `/runtime/runs/${encodeURIComponent(i.link.runId)}`;
    if (i.link.kind === "environment")
        return `/runtime/environments/${encodeURIComponent(i.link.environmentId)}`;
    if (i.link.kind === "cell")
        return `/runtime/environments#${CELLS_SECTION_ID}`;
    return undefined;
}

/** Where an error's catalog card is: the environment's health (its setup blocker), else the Run page. */
export function blockerHref(e: {
    environmentId?: string;
    runId?: string;
}): string | undefined {
    if (e.environmentId)
        return `/runtime/environments/${encodeURIComponent(e.environmentId)}`;
    if (e.runId) return `/runtime/runs/${encodeURIComponent(e.runId)}`;
    return undefined;
}

export interface HealthTile {
    label: string;
    value: string;
    hint?: string;
}

const measuredOr = <T>(
    part: ({ measured: true } & T) | { measured: false; reason: string },
    f: (p: T) => HealthTile,
): HealthTile =>
    part.measured
        ? f(part)
        : { label: "", value: HEALTH_NOT_MEASURED, hint: part.reason };

/** The summary tiles: setups, the week's Runs, boot times against the week before, and what is stuck. */
export function healthSummaryTiles(h: RuntimeHealth): HealthTile[] {
    const setups = measuredOr(h.summary.setups, (s) => ({
        label: "Environments ready",
        value: String(s.active),
        hint: `${s.blocked} blocked · ${s.settingUp} setting up`,
    }));
    const runs = measuredOr(h.summary.runs, (r) => ({
        label: `Runs, last ${r.days} days`,
        value: String(r.total),
        hint:
            Object.entries(r.byVerdict)
                .sort((a, b) => b[1] - a[1])
                .map(([v, n]) => `${n} ${runStateLabel(v).toLowerCase()}`)
                .join(" · ") || "none",
    }));
    const boot = measuredOr(h.summary.boot, (b) => ({
        label: "Boot time, last 7 days",
        value: b.thisWeek.count
            ? `${formatDurationMs(b.thisWeek.p50Ms)} / ${formatDurationMs(b.thisWeek.p95Ms)}`
            : "No boot",
        hint: b.thisWeek.count
            ? `median / slowest 5 % · ${bootTrendLine(b.trend, b.lastWeek.p95Ms)}`
            : undefined,
    }));
    const stuck = measuredOr(h.stuck, (s) => ({
        label: "Stuck now",
        value: String(s.items.length),
        hint: s.items.length
            ? "Past the longest they should take"
            : "Nothing past its time limit",
    }));
    return [
        { ...setups, label: setups.label || "Environments ready" },
        { ...runs, label: runs.label || "Runs, last 7 days" },
        { ...boot, label: boot.label || "Boot time, last 7 days" },
        { ...stuck, label: stuck.label || "Stuck now" },
    ];
}

export function bootTrendLine(
    trend: "faster" | "slower" | "same" | "no_data",
    lastP95Ms: number | null,
): string {
    if (trend === "no_data") return "no week before to compare";
    const before = formatDurationMs(lastP95Ms);
    if (trend === "slower") return `slower than the week before (${before})`;
    if (trend === "faster") return `faster than the week before (${before})`;
    return `about the same as the week before (${before})`;
}

export const stuckTone = (i: RuntimeHealthStuck): Tone =>
    i.subject === "cell" || i.boundMs === 0 ? "danger" : "warning";

/** Today's cost in one line: the total when both parts are priced, else what is known and what is missing. */
export function costTodayLine(
    h: RuntimeHealth,
    usd: (v: number | null) => string,
): { value: string; hint: string } {
    const t = h.cost.today;
    if (!t.measured) return { value: HEALTH_NOT_MEASURED, hint: t.reason };
    // The org's own hosts priced at its price per host-hour (Runtime settings).
    const ownPrice =
        t.ownHostUsdPerHour != null
            ? `, your hosts at $${t.ownHostUsdPerHour}/h`
            : "";
    const machines = `${usd(t.machineUsd)} machines${ownPrice}`;
    if (t.totalUsd !== null)
        return {
            value: usd(t.totalUsd),
            hint: `${usd(t.llmUsd)} LLM · ${machines}`,
        };
    // Not priced while the org has hosts of its own and no price for them: say where to set one.
    const ownHosts =
        h.cells.measured && h.cells.items.some((c) => c.owner === "customer");
    const setPrice =
        ownHosts && t.ownHostUsdPerHour == null
            ? ": set a price per host-hour in Runtime settings"
            : "";
    const parts = [
        t.llmUsd !== null ? `${usd(t.llmUsd)} LLM` : "LLM not measured",
        t.machineUsd !== null
            ? machines
            : t.gbMinutes !== null
              ? `${t.gbMinutes} GB·min of machines, not priced${setPrice}`
              : "machines not measured",
    ];
    return { value: HEALTH_NOT_MEASURED, hint: parts.join(" · ") };
}
