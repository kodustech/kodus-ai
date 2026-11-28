"use client";

import { useState } from "react";
import { RuntimeSection } from "@components/runtime/section";
import { Input } from "@components/ui/input";
import type { RuntimeUsageReport } from "@services/runtime/contracts";
import {
    costOfRunView,
    estimateMonth,
    formatRate,
    monthSeed,
    perMillionLine,
    setupsAndPreviews,
} from "@services/runtime/model/runtime-cost";
import {
    formatUnitMinutes,
    formatUsageUsd,
    NOT_MEASURED,
} from "@services/runtime/model/usage-report";

// The Runtime cost block of the usage tab: what a Run costs, what it is
// priced with, and a month calculator seeded from the org's own month. Every
// US$ here is an ESTIMATED cost at list price: a lower bound on what the
// Runs cost Kodus, never a price the customer pays.

const NOT_A_PRICE = "Not a price you pay.";
const EXAMPLE_PRS = [100, 300, 1000];

const CostOfARun = ({ report }: { report: RuntimeUsageReport }) => {
    const view = costOfRunView(report);
    return (
        <RuntimeSection
            title="Cost of a Run"
            description={`Estimated cost at list price, a lower bound. ${NOT_A_PRICE}`}>
            {!view ? (
                <p className="text-text-secondary text-sm">
                    {NOT_MEASURED}: no Run was priced in full this month.
                </p>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                        <span className="text-text-primary font-mono text-3xl">
                            {formatUsageUsd(view.medianUsd)}
                        </span>
                        <span className="text-text-tertiary text-sm">
                            median Run, max {formatUsageUsd(view.maxUsd)}
                        </span>
                    </div>
                    <p className="text-text-secondary text-sm">
                        Machines {formatUsageUsd(view.machinesUsd)} · LLM, Kodus
                        keys {formatUsageUsd(view.llmManagedUsd)} · LLM, your
                        own keys {formatUsageUsd(view.llmByokUsd)}
                    </p>
                    <p className="text-text-tertiary text-xs">
                        The median of each part over the Runs priced in full;
                        the parts need not add up to the median Run.{" "}
                        {view.pricedInFull} of {view.runs} Runs priced in full.
                    </p>
                </div>
            )}
        </RuntimeSection>
    );
};

const HowRunsArePriced = ({ report }: { report: RuntimeUsageReport }) => {
    const p = report.pricing;
    return (
        <RuntimeSection
            title="How Runs are priced"
            description="What the estimates above are made of, read from this month's Runs. Where a price does not exist it says so.">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-text-secondary">Machines</dt>
                <dd className="flex flex-col gap-1">
                    {p.hosts.length ? (
                        p.hosts.map((h) => (
                            <span key={`${h.instanceType}-${h.region}`}>
                                Kodus host {h.instanceType}, $
                                {h.usdPerHour}/h list price ({h.region})
                            </span>
                        ))
                    ) : (
                        <span>
                            Host price: not set. A Kodus host&apos;s list price
                            comes from the Runtime cell price list; no priced
                            Kodus host ran a Run this month.
                        </span>
                    )}
                    {p.ownHostUsdPerHour !== null && (
                        <span>
                            Your host: ${p.ownHostUsdPerHour.toFixed(2)}/h, the
                            price you set in Runtime settings
                        </span>
                    )}
                    <span>
                        {p.effectiveUsdPerGbHour !== null
                            ? `Rate per GB·h: ${formatRate(p.effectiveUsdPerGbHour)} per GB·h held (effective, derived from the host price by the share of its memory a Run held)`
                            : "Rate per GB·h: not set. It is derived from a Kodus host's list price and the memory Runs held."}
                    </span>
                    <span className="text-text-tertiary">
                        vCPU: not priced separately (shared host)
                    </span>
                    <span className="text-text-tertiary">
                        Disk: not measured
                    </span>
                </dd>
                <dt className="text-text-secondary">LLM</dt>
                <dd className="flex flex-col gap-2">
                    {!p.llmModels.length ? (
                        <span>No LLM call priced this month.</span>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {p.llmModels.map((m) => (
                                <li
                                    key={`${m.model}-${m.paidBy}`}
                                    className="flex flex-col">
                                    <span>
                                        <span className="font-mono">
                                            {m.model || "unnamed model"}
                                        </span>{" "}
                                        <span className="text-text-tertiary">
                                            ·{" "}
                                            {m.paidBy === "customer"
                                                ? "Your own keys (BYOK)"
                                                : "Kodus keys (managed)"}
                                        </span>
                                    </span>
                                    <span className="text-text-secondary">
                                        {perMillionLine(m)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                    <span className="text-text-tertiary text-xs">
                        A prompt above a model&apos;s tier threshold is priced
                        whole at that tier.
                    </span>
                </dd>
                <dt className="text-text-secondary">Not counted</dt>
                <dd className="text-text-secondary">
                    Idle host time, the warm pool and egress traffic. Every
                    figure here is a lower bound at list price. {NOT_A_PRICE}
                </dd>
            </dl>
        </RuntimeSection>
    );
};

const toInput = (n: number | null) => (n === null ? "" : String(n));
const toNumber = (text: string) => {
    const t = text.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
};

const MonthCalculator = ({ report }: { report: RuntimeUsageReport }) => {
    const seed = monthSeed(report);
    const [prs, setPrs] = useState(toInput(seed.prs));
    const [runsPerPr, setRunsPerPr] = useState(toInput(seed.runsPerPr));
    const [cost, setCost] = useState(toInput(seed.costPerRunUsd));
    const inputs = {
        prs: toNumber(prs),
        runsPerPr: toNumber(runsPerPr),
        costPerRunUsd: toNumber(cost),
    };
    const month = estimateMonth(inputs);
    const extra = setupsAndPreviews(report);
    const seeded = (n: number | null) =>
        n === null
            ? `no ${report.month} figure to start from`
            : `${report.month}: ${n}`;

    const field = (
        label: string,
        value: string,
        set: (v: string) => void,
        hint: string,
        step: string,
    ) => (
        <label className="flex flex-col gap-1 text-sm">
            <span className="text-text-secondary">{label}</span>
            <Input
                type="number"
                min={0}
                step={step}
                inputMode="decimal"
                aria-label={label}
                value={value}
                onChange={(e) => set(e.target.value)}
            />
            <span className="text-text-tertiary text-xs">{hint}</span>
        </label>
    );

    return (
        <RuntimeSection
            title="What would a month cost?"
            description="Start from your own month and change the numbers. It is an estimate at list price.">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {field(
                    "PRs per month",
                    prs,
                    setPrs,
                    seeded(seed.prs),
                    "1",
                )}
                {field(
                    "Runs per PR",
                    runsPerPr,
                    setRunsPerPr,
                    seeded(seed.runsPerPr),
                    "0.1",
                )}
                {field(
                    "Cost per Run, in US$",
                    cost,
                    setCost,
                    seed.costPerRunUsd === null
                        ? "no priced Run to start from"
                        : `median Run of ${report.month}, editable`,
                    "0.01",
                )}
            </div>
            {month === null ? (
                <p className="text-text-secondary text-sm">
                    Fill in the three numbers to see an estimate.
                </p>
            ) : (
                <div className="flex flex-col gap-2">
                    <p className="text-text-primary text-lg">
                        Estimated cost:{" "}
                        <span className="font-mono">
                            {formatUsageUsd(month)}
                        </span>{" "}
                        a month
                    </p>
                    <ul className="text-text-secondary flex flex-wrap gap-x-6 gap-y-1 text-sm">
                        {EXAMPLE_PRS.map((n) => {
                            const usd = estimateMonth({ ...inputs, prs: n });
                            return (
                                <li key={n}>
                                    {`${n.toLocaleString("en-US")} PRs ${formatUsageUsd(usd)}`}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
            <p className="text-text-tertiary text-xs">
                An estimate at list price: PRs × Runs per PR × the cost per Run.
                It leaves out the idle host, the warm pool and egress, so it is
                a lower bound. {NOT_A_PRICE}
            </p>
            {extra ? (
                <p className="text-text-secondary text-sm">
                    {`Setups and previews in ${report.month}: ${formatUnitMinutes(extra.gbMinutes, "GB·min")} of machine time, ${extra.usd === null ? "not priced" : `about ${formatUsageUsd(extra.usd)}`}, not in the estimate above`}
                </p>
            ) : (
                <p className="text-text-tertiary text-sm">
                    No setup or preview machine time in {report.month}.
                </p>
            )}
        </RuntimeSection>
    );
};

/** The cost of a Run and how it is priced, with the month calculator beside them. */
export const RuntimeCostBlock = ({
    report,
}: {
    report: RuntimeUsageReport;
}) => (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-6">
            <CostOfARun report={report} />
            <HowRunsArePriced report={report} />
        </div>
        {/* Reseeded when the month or a filter changes the report. */}
        <MonthCalculator
            key={`${report.month}-${JSON.stringify(report.filters)}`}
            report={report}
        />
    </div>
);
