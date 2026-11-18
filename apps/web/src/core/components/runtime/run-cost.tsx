import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import type { RuntimeRunCost } from "@services/runtime/contracts";
import { formatEstimatedUsd } from "@services/runtime/format";

// The cost of a Run (§13 PR 5), always an estimate: machine time and LLM
// tokens at list prices. On a shared cell (docker-gvisor) the machine part is
// the share of the cell's host the Run's claims held (GB·h of its memory); on
// a VM cell (aws-ec2) it is the VMs for the Run's wall time. On the org's own
// shared cell it is the same share at the price per host-hour the org set in
// Runtime settings. A part that could not be priced says why instead of
// reading as free.

const minutes = (m: number) => (m < 1 ? "under 1 min" : `${Math.round(m)} min`);

/** GB·h of host memory held, one decimal (two under 1 GB·h). */
const gbHours = (mbMinutes: number) => {
    const h = mbMinutes / 1024 / 60;
    return `${h < 1 ? h.toFixed(2) : h.toFixed(1)} GB·h held`;
};

const modelOf = (cost: RuntimeRunCost) => cost.machines.model ?? "vm";

const machinesLine = (cost: RuntimeRunCost) => {
    const m = cost.machines;
    const model = modelOf(cost);
    if (model === "shared_cell") {
        const where =
            m.paidBy === "customer"
                ? "Your host"
                : m.host
                  ? `Kodus host ${m.host.instanceType}`
                  : "Kodus host";
        const held = m.mbMinutes != null ? ` · ${gbHours(m.mbMinutes)}` : "";
        const price = m.host
            ? ` · list price $${m.host.usdPerHour}/h, ${m.host.region}`
            : m.paidBy === "customer" && m.ownHostUsdPerHour != null
              ? ` · your price $${m.ownHostUsdPerHour}/h`
              : "";
        return `${where}${held}${price}`;
    }
    if (model === "unknown")
        return m.usd === 0
            ? "No machine held yet"
            : "Machine time not recorded for this Run";
    return `${m.vm.count} × ${m.vm.instanceType} + ${m.observer.count} × ${m.observer.instanceType}, ${minutes(m.minutes)} · list price, ${m.region}`;
};

/** A shared cell's share is often under a cent: three decimals there, never "< $0.01". */
const machinesUsd = (usd: number | null) =>
    usd != null && usd > 0 && usd < 0.1
        ? usd < 0.001
            ? "< $0.001"
            : `≈ $${usd.toFixed(3)}`
        : formatEstimatedUsd(usd);

const machinesValue = (cost: RuntimeRunCost) => {
    if (cost.machines.paidBy === "customer" && cost.machines.usd === null)
        return "On your host";
    if (cost.machines.usd === null && cost.machines.unpriced)
        return "Not priced";
    return modelOf(cost) === "shared_cell"
        ? machinesUsd(cost.machines.usd)
        : formatEstimatedUsd(cost.machines.usd);
};

const llmNotMeasured = (cost: RuntimeRunCost) =>
    cost.llm.source === "not_measured";

const llmValue = (cost: RuntimeRunCost) =>
    llmNotMeasured(cost)
        ? "Not measured"
        : cost.llm.usd === null && cost.llm.tokens > 0
          ? "Not priced"
          : formatEstimatedUsd(cost.llm.usd);

const llmLine = (cost: RuntimeRunCost) => {
    if (llmNotMeasured(cost)) return "Token usage is not readable right now";
    const parts = [`${cost.llm.tokens.toLocaleString()} tokens`];
    const models = cost.llm.models
        .map((m) => m.model)
        .filter((m): m is string => !!m);
    if (models.length) parts.push(models.join(", "));
    if (cost.llm.unsettledTokens > 0)
        parts.push(
            `${cost.llm.unsettledTokens.toLocaleString()} not settled yet`,
        );
    if ((cost.llm.customerUsd ?? 0) > 0)
        parts.push(
            `${formatEstimatedUsd(cost.llm.customerUsd)} on your own keys`,
        );
    return parts.join(" · ");
};

/** Why the total is partial, in words; undefined when it is whole. */
export const costCaveat = (cost: RuntimeRunCost): string | undefined => {
    const notes: string[] = [];
    if (cost.machines.paidBy === "customer") {
        // Priced at the org's own price per host-hour: nothing missing. A per-VM host is never priced by it.
        if (cost.machines.usd === null)
            notes.push(
                modelOf(cost) === "shared_cell"
                    ? "machines run on your own host and are not counted; set a price per host-hour in Runtime settings to count them"
                    : "machines run on your own host and are not counted",
            );
    }
    else if (cost.machines.unpriced === "missing_claim_facts")
        notes.push("the machine time was not recorded for this Run");
    else if (cost.machines.unpriced === "cell_price_unknown")
        notes.push("the Kodus host has no list price configured");
    if (llmNotMeasured(cost)) notes.push("the LLM usage could not be read");
    else if (cost.llm.usd === null && cost.llm.tokens > 0)
        notes.push("some tokens are from a model without a list price");
    return notes.length ? `Partial: ${notes.join("; ")}.` : undefined;
};

/** The Run page: total, then one row per part. */
export const RunCostBreakdown = ({ cost }: { cost: RuntimeRunCost }) => {
    const caveat = costCaveat(cost);
    return (
        <div className="flex flex-col gap-2 text-sm">
            <dl className="grid grid-cols-[auto_1fr_auto] gap-x-4 gap-y-1">
                <dt className="text-text-secondary">Machines</dt>
                <dd className="text-text-tertiary text-xs leading-5">
                    {machinesLine(cost)}
                </dd>
                <dd className="text-right font-mono">{machinesValue(cost)}</dd>
                <dt className="text-text-secondary">LLM</dt>
                <dd className="text-text-tertiary text-xs leading-5">
                    {llmLine(cost)}
                </dd>
                <dd className="text-right font-mono">{llmValue(cost)}</dd>
                <dt className="text-text-primary font-medium">Total</dt>
                <dd className="text-text-tertiary text-xs leading-5">
                    estimate
                </dd>
                <dd className="text-right font-mono font-medium">
                    {formatEstimatedUsd(cost.totalUsd)}
                </dd>
            </dl>
            <p className="text-text-tertiary text-xs">
                An estimate from list prices and the time the machines were
                held, not a bill.{caveat ? ` ${caveat}` : ""}
            </p>
        </div>
    );
};

/** A list row: the total, with the breakdown on hover or focus. */
export const RunCostTotal = ({ cost }: { cost?: RuntimeRunCost }) => {
    if (!cost) return <span className="text-text-tertiary">—</span>;
    const caveat = costCaveat(cost);
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className="font-mono text-xs underline decoration-dotted underline-offset-2">
                    {formatEstimatedUsd(cost.totalUsd)}
                    {caveat ? "*" : ""}
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
                <p>Machines: {machinesValue(cost)}</p>
                <p className="text-text-tertiary">{machinesLine(cost)}</p>
                <p className="mt-1">LLM: {llmValue(cost)}</p>
                <p className="text-text-tertiary">{llmLine(cost)}</p>
                <p className="text-text-tertiary mt-1">
                    Estimate from list prices.{caveat ? ` ${caveat}` : ""}
                </p>
            </TooltipContent>
        </Tooltip>
    );
};
