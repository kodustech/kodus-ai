"use client";

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
} from "@components/ui/accordion";
import { Card } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { formatUsd } from "@services/usage/format";
import {
    CostBreakdown,
    EnrichedModelUsage,
    ModelPricingInfo,
    TierUsage,
} from "@services/usage/types";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";

import { M } from "../_lib/constants";

/** Sum a slice of bracket buckets into one (for the ≤/>threshold collapse). */
function mergeTierUsage(buckets: TierUsage[]): TierUsage {
    return buckets.reduce(
        (acc, b) => ({
            input: acc.input + b.input,
            output: acc.output + b.output,
            total: acc.total + b.total,
            outputReasoning: acc.outputReasoning + b.outputReasoning,
            cacheRead: acc.cacheRead + b.cacheRead,
            cacheWrite: acc.cacheWrite + b.cacheWrite,
        }),
        {
            input: 0,
            output: 0,
            total: 0,
            outputReasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
        },
    );
}

function mergeCost(costs: CostBreakdown[]): CostBreakdown {
    return costs.reduce(
        (acc, c) => ({
            input: acc.input + c.input,
            output: acc.output + c.output,
            cacheRead: acc.cacheRead + c.cacheRead,
            cacheWrite: acc.cacheWrite + c.cacheWrite,
            total: acc.total + c.total,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    );
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
}

/**
 * Strip the provider prefix `google_gemini:` if it leaked through and trim
 * the `:free` / dated suffixes the same way the existing CostCards do.
 */
function displayModelName(model: string): string {
    return model
        .replace(/^[^:/]+[:/]/, "")
        .replace(/-\d{8}$/, "")
        .replace(/:free$/, "");
}

interface PriceCellInput {
    tokens: number;
    cost: number;
}

function PriceCell({ tokens, cost }: PriceCellInput) {
    if (tokens === 0 && cost === 0) {
        return <span className="text-text-tertiary tabular-nums">—</span>;
    }
    return (
        <span className="tabular-nums">
            <span className="text-text-primary">{formatTokens(tokens)}</span>
            <span className="text-text-tertiary"> · {formatUsd(cost)}</span>
        </span>
    );
}

function PricingTooltip({
    info,
    threshold,
}: {
    info: ModelPricingInfo | undefined;
    threshold: number | undefined;
}) {
    if (!info?.pricing) return null;
    const { input, output, cacheRead, cacheWrite } = info.pricing;
    const hasTier = !!(
        input.tiers?.length ||
        output.tiers?.length ||
        cacheRead.tiers?.length ||
        cacheWrite.tiers?.length
    );

    // Collapsed display: the ">threshold" column shows the first tier's rate
    // (a multi-tier model's higher bands aren't broken out in the tooltip).
    const row = (
        label: string,
        rate: { default: number; tiers?: Array<{ rate: number }> },
    ) => (
        <tr>
            <td className="text-text-secondary pr-3">{label}</td>
            <td className="text-text-primary pr-3 text-right tabular-nums">
                ${(rate.default * M).toFixed(4)}
            </td>
            {hasTier && (
                <td className="text-text-primary text-right tabular-nums">
                    {rate.tiers?.[0]
                        ? `$${(rate.tiers[0].rate * M).toFixed(4)}`
                        : "—"}
                </td>
            )}
        </tr>
    );

    return (
        <Tooltip>
            {/* span, not button: this trigger renders inside the AccordionTrigger
                (itself a <button>), and a nested <button> is invalid HTML that
                trips React hydration. tabIndex keeps it keyboard-focusable so the
                tooltip still opens on focus. */}
            <TooltipTrigger asChild>
                <span
                    role="button"
                    tabIndex={0}
                    className="text-text-tertiary hover:text-text-primary inline-flex size-4 cursor-help items-center justify-center">
                    <InfoIcon className="size-3.5" />
                </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-sm p-3 text-xs">
                <p className="text-text-primary mb-2 font-medium">
                    Rates per 1M tokens
                </p>
                <table className="w-full text-left">
                    <thead>
                        <tr>
                            <th className="text-text-tertiary pr-3"></th>
                            <th className="text-text-tertiary pr-3 text-right">
                                {hasTier ? `≤ ${formatTokens(threshold ?? 0)}` : "Rate"}
                            </th>
                            {hasTier && (
                                <th className="text-text-tertiary text-right">
                                    {`> ${formatTokens(threshold ?? 0)}`}
                                </th>
                            )}
                        </tr>
                    </thead>
                    <tbody>
                        {row("Input", input)}
                        {row("Output", output)}
                        {row("Cache read", cacheRead)}
                        {cacheWrite.default > 0 && row("Cache write", cacheWrite)}
                    </tbody>
                </table>
                {hasTier && (
                    <p className="text-text-tertiary mt-2 text-pretty">
                        The tier is applied per call — a single request that
                        exceeds {formatTokens(threshold ?? 0)} input tokens is
                        billed at the extended rate.
                    </p>
                )}
            </TooltipContent>
        </Tooltip>
    );
}

function MissingPricingBadge() {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs">
                    <AlertTriangleIcon className="size-3" />
                    Price unavailable
                </span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs text-xs">
                We couldn't find pricing for this model in the catalog. The
                cost shown is zero and this row is excluded from the totals
                above.
            </TooltipContent>
        </Tooltip>
    );
}

function ModelBlock({
    row,
    pricingInfo,
}: {
    row: EnrichedModelUsage;
    pricingInfo: ModelPricingInfo | undefined;
}) {
    const uncachedInput = Math.max(0, row.input - (row.cacheRead ?? 0));
    const isTiered = !!row.byTier && !!row.costByTier;

    // The cost pipeline is N-tier internally; the table collapses it to two
    // display buckets: `le` = the default-rate band (bracket 0), `gt` = every
    // tiered band summed (brackets ≥1), with the cost summed correctly across
    // whatever number of tiers the model has.
    const le = isTiered ? row.byTier![0] : undefined;
    const gt = isTiered ? mergeTierUsage(row.byTier!.slice(1)) : undefined;
    const leCost = isTiered ? row.costByTier![0] : undefined;
    const gtCost = isTiered ? mergeCost(row.costByTier!.slice(1)) : undefined;
    // Label uses the FIRST breakpoint ("≤/>threshold"); for a multi-tier model
    // the ">threshold" line blends the bands above it (cost stays exact).
    const inputThreshold = pricingInfo?.pricing?.input?.tiers?.[0]?.threshold;
    const showCacheWrite = (row.cacheWrite ?? 0) > 0;

    const totalUncached =
        (le ? le.input - le.cacheRead : 0) + (gt ? gt.input - gt.cacheRead : 0);
    const leUncached = le ? Math.max(0, le.input - le.cacheRead) : 0;
    const gtUncached = gt ? Math.max(0, gt.input - gt.cacheRead) : 0;

    return (
        <Card className="p-0">
            <AccordionItem value={row.model} className="border-none">
                <AccordionTrigger className="hover:no-underline px-4 py-3">
                    <div className="flex flex-1 items-center justify-between gap-3">
                        <div
                            className="flex items-center gap-2"
                            onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-text-primary font-medium">
                                {displayModelName(row.model)}
                            </h3>
                            <PricingTooltip
                                info={pricingInfo}
                                threshold={inputThreshold}
                            />
                            {row.pricingSource === "missing" && (
                                <MissingPricingBadge />
                            )}
                        </div>
                        <p className="text-text-primary text-lg font-semibold tabular-nums">
                            {formatUsd(row.cost.total)}
                        </p>
                    </div>
                </AccordionTrigger>
                <AccordionContent className="px-4 pt-0 pb-4">
                    <table className="w-full text-sm">
                <thead>
                    <tr className="text-text-tertiary border-card-lv1 border-b">
                        <th className="py-2 text-left font-normal"></th>
                        {isTiered ? (
                            <>
                                <th className="py-2 text-right font-normal">
                                    ≤ {formatTokens(inputThreshold ?? 0)}
                                </th>
                                <th className="py-2 text-right font-normal">
                                    {"> "}
                                    {formatTokens(inputThreshold ?? 0)}
                                </th>
                            </>
                        ) : (
                            <th className="py-2 text-right font-normal">
                                Rate
                            </th>
                        )}
                        <th className="py-2 text-right font-normal">Total</th>
                    </tr>
                </thead>
                <tbody className="divide-card-lv1 divide-y">
                    <tr>
                        <td className="text-text-secondary py-2">
                            Uncached input
                        </td>
                        {isTiered ? (
                            <>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={leUncached}
                                        cost={leCost!.input}
                                    />
                                </td>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={gtUncached}
                                        cost={gtCost!.input}
                                    />
                                </td>
                            </>
                        ) : (
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={uncachedInput}
                                    cost={row.cost.input}
                                />
                            </td>
                        )}
                        <td className="py-2 text-right">
                            <PriceCell
                                tokens={isTiered ? totalUncached : uncachedInput}
                                cost={row.cost.input}
                            />
                        </td>
                    </tr>
                    <tr>
                        <td className="text-text-secondary py-2">
                            Cache read
                        </td>
                        {isTiered ? (
                            <>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={le!.cacheRead}
                                        cost={leCost!.cacheRead}
                                    />
                                </td>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={gt!.cacheRead}
                                        cost={gtCost!.cacheRead}
                                    />
                                </td>
                            </>
                        ) : (
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={row.cacheRead ?? 0}
                                    cost={row.cost.cacheRead}
                                />
                            </td>
                        )}
                        <td className="py-2 text-right">
                            <PriceCell
                                tokens={row.cacheRead ?? 0}
                                cost={row.cost.cacheRead}
                            />
                        </td>
                    </tr>
                    <tr>
                        <td className="text-text-secondary py-2">Output</td>
                        {isTiered ? (
                            <>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={le!.output}
                                        cost={leCost!.output}
                                    />
                                </td>
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={gt!.output}
                                        cost={gtCost!.output}
                                    />
                                </td>
                            </>
                        ) : (
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={row.output}
                                    cost={row.cost.output}
                                />
                            </td>
                        )}
                        <td className="py-2 text-right">
                            <PriceCell tokens={row.output} cost={row.cost.output} />
                        </td>
                    </tr>
                    {showCacheWrite && (
                        <tr>
                            <td className="text-text-secondary py-2">
                                Cache write
                            </td>
                            {isTiered ? (
                                <>
                                    <td className="py-2 text-right">
                                        <PriceCell
                                            tokens={le!.cacheWrite}
                                            cost={leCost!.cacheWrite}
                                        />
                                    </td>
                                    <td className="py-2 text-right">
                                        <PriceCell
                                            tokens={gt!.cacheWrite}
                                            cost={gtCost!.cacheWrite}
                                        />
                                    </td>
                                </>
                            ) : (
                                <td className="py-2 text-right">
                                    <PriceCell
                                        tokens={row.cacheWrite ?? 0}
                                        cost={row.cost.cacheWrite}
                                    />
                                </td>
                            )}
                            <td className="py-2 text-right">
                                <PriceCell
                                    tokens={row.cacheWrite ?? 0}
                                    cost={row.cost.cacheWrite}
                                />
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
                </AccordionContent>
            </AccordionItem>
        </Card>
    );
}

export const ModelBreakdownTable = ({
    rows,
    pricing,
}: {
    rows: EnrichedModelUsage[];
    pricing: Record<string, ModelPricingInfo>;
}) => {
    if (rows.length === 0) return null;
    return (
        <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold">Per-model breakdown</h2>
            <Accordion type="multiple" className="flex flex-col gap-3">
                {rows.map((row) => (
                    <ModelBlock
                        key={row.model}
                        row={row}
                        pricingInfo={pricing[row.model]}
                    />
                ))}
            </Accordion>
        </div>
    );
};
