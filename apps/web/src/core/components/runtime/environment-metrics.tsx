import type { EnvironmentMetrics as Metrics } from "@services/runtime/contracts";
import { formatDurationMs, formatRate } from "@services/runtime/format";
import { cn } from "src/core/utils/components";

import { Metric } from "./section";

/** The targets of docs §11, said the same way on every screen. */
export const BOOT_RATE_TARGET = 0.8;
export const READY_P90_TARGET_MS = 90_000;

const setupHint = (boots: number) =>
    `From ${boots} setup${boots === 1 ? "" : "s"} this week: no Run has booted yet. A setup builds from zero, so a Run on the bake is faster.`;

/**
 * Boot success, time to ready and Runs over 7 days (environment detail and
 * health). The Runs' numbers come first; a card the Runs cannot fill (no Run
 * booted this week) shows the setups' instead, says so, and is not held to
 * the Run targets.
 */
export const EnvironmentMetrics = ({ metrics }: { metrics?: Metrics }) => {
    const setups = metrics?.setupBoots;
    const rateFromSetups =
        metrics?.bootRate7d === undefined && setups !== undefined;
    const readyFromSetups =
        metrics?.readyP50Ms === undefined && setups?.readyP50Ms !== undefined;
    const bootRate = rateFromSetups ? setups?.bootRate7d : metrics?.bootRate7d;
    const readyP50 = readyFromSetups ? setups?.readyP50Ms : metrics?.readyP50Ms;
    const readyP90 = readyFromSetups ? setups?.readyP90Ms : metrics?.readyP90Ms;
    const belowTarget =
        !rateFromSetups && bootRate !== undefined && bootRate < BOOT_RATE_TARGET;
    const slow =
        !readyFromSetups &&
        readyP90 !== undefined &&
        readyP90 > READY_P90_TARGET_MS;
    return (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric
                label="Boot success (7d)"
                value={
                    <span className={cn(belowTarget && "text-warning")}>
                        {formatRate(bootRate)}
                    </span>
                }
                hint={
                    rateFromSetups
                        ? setupHint(setups!.boots7d)
                        : `Runs that booted without a human blocker. Target ${formatRate(BOOT_RATE_TARGET)}.`
                }
            />
            <Metric
                label="Time to ready (p50)"
                value={formatDurationMs(readyP50)}
                hint={readyFromSetups ? setupHint(setups!.boots7d) : undefined}
            />
            <Metric
                label="Time to ready (p90)"
                value={
                    <span className={cn(slow && "text-warning")}>
                        {formatDurationMs(readyP90)}
                    </span>
                }
                hint={
                    readyFromSetups
                        ? "Setups are not held to the Run target."
                        : `Target under ${formatDurationMs(READY_P90_TARGET_MS)}.`
                }
            />
            <Metric label="Runs (7d)" value={metrics?.runs7d ?? "—"} />
        </div>
    );
};
