"use client";

import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { getSpendLimitStatus } from "@services/spend-limit/fetch";
import { useQuery } from "@tanstack/react-query";
import { HelpCircleIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

// Alert thresholds — shown as ticks so the limit's "danger zone" is legible.
const THRESHOLDS = [50, 75, 90];

const money = (n: number) =>
    `$${n.toLocaleString("en-US", {
        minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
        maximumFractionDigits: 2,
    })}`;

export const SpendLimitProgress = () => {
    const { data } = useQuery({
        queryKey: ["spend-limit-status"],
        queryFn: getSpendLimitStatus,
        retry: false,
    });

    if (!data || data.limitUsd <= 0) return null;

    const pct = data.pct;
    const fill = Math.min(100, Math.max(0, pct));
    const over = data.isOverLimit;
    const near = !over && pct >= 90;

    const barColor = over ? "bg-danger" : near ? "bg-warning" : "bg-success";
    const pctColor = over
        ? "text-danger"
        : near
          ? "text-warning"
          : "text-text-secondary";

    return (
        <Card className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="flex items-center gap-1.5">
                    <p className="text-text-secondary text-sm text-pretty">
                        Monthly spend limit (BYOK)
                    </p>
                    <Tooltip>
                        <TooltipContent className="text-text-primary max-w-64 text-pretty">
                            This bar always reflects spend from the start of the
                            current month through today and ignores the date
                            filter above.
                        </TooltipContent>
                        <TooltipTrigger asChild>
                            <Button variant="cancel" size="icon-xs">
                                <HelpCircleIcon className="size-3.5" />
                            </Button>
                        </TooltipTrigger>
                    </Tooltip>
                </div>
                <p className="text-text-primary text-sm tabular-nums">
                    <span className="font-semibold">{money(data.spentUsd)}</span>
                    <span className="text-text-tertiary">
                        {" "}
                        of {money(data.limitUsd)}
                    </span>
                    <span className={cn("ml-2 font-medium", pctColor)}>
                        {pct.toFixed(0)}%
                    </span>
                </p>
            </div>

            <div
                className="bg-card-lv2 relative h-2 w-full rounded-full"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Monthly BYOK spend versus limit">
                <div
                    className={cn("h-full rounded-full", barColor)}
                    style={{ width: `${fill}%` }}
                />
                {THRESHOLDS.map((t) => (
                    <span
                        key={t}
                        className="bg-card-lv3 absolute top-0 h-full w-px"
                        style={{ left: `${t}%` }}
                        aria-hidden
                    />
                ))}
                {/* The limit itself — a dotted marker at 100% (the bar's end). */}
                <span
                    className="border-text-tertiary absolute -top-1 right-0 h-4 border-r border-dashed"
                    aria-hidden
                />
            </div>

            {over && (
                <p className="text-danger text-xs text-pretty">
                    Over your monthly limit. This is an alert only — reviews keep
                    running. Set a hard cap with your provider to stop spend.
                </p>
            )}
        </Card>
    );
};
