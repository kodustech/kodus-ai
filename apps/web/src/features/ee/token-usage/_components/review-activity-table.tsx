"use client";

import { useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    ModelPricingInfo,
    UsageByReviewResultContract,
} from "@services/usage/types";

import { rowCost } from "../_utils/cost";

// Collapsed by default; "Show all" expands up to CAP (bounded so a huge
// period doesn't blow up the DOM) and flips to "Show less".
const INITIAL = 12;
const CAP = 100;

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1000000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1000000).toFixed(1)}M`;
};

const formatUsd = (v: number) => {
    if (v < 0.01 && v > 0) return "<$0.01";
    return `$${v.toFixed(2)}`;
};

const formatWhen = (iso?: string) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
};

interface RunRow {
    review: string;
    prNumber?: number;
    startedAt?: string;
    models: string[];
    tokens: number;
    cost: number;
}

/**
 * OpenRouter-style activity table: one row per review run, sorted by spend.
 * The chart above answers "which runs are expensive"; this answers "what
 * exactly ran, when, with which models, and what it cost".
 */
export const ReviewActivityTable = ({
    rows,
    selectedModels,
    pricing,
}: {
    rows: UsageByReviewResultContract[];
    selectedModels: string[];
    pricing: Record<string, ModelPricingInfo>;
}) => {
    const [expanded, setExpanded] = useState(false);

    const runs = useMemo(() => {
        const selected = new Set(selectedModels);
        const byRun = new Map<string, RunRow>();
        for (const row of rows) {
            if (!selected.has(row.model)) continue;
            const existing = byRun.get(row.review);
            const cost = rowCost(row, pricing[row.model]).total;
            if (!existing) {
                byRun.set(row.review, {
                    review: row.review,
                    prNumber: row.prNumber,
                    startedAt: row.startedAt,
                    models: [row.model],
                    tokens: row.total,
                    cost,
                });
            } else {
                existing.tokens += row.total;
                existing.cost += cost;
                if (!existing.models.includes(row.model)) {
                    existing.models.push(row.model);
                }
                if (
                    row.startedAt &&
                    (!existing.startedAt || row.startedAt < existing.startedAt)
                ) {
                    existing.startedAt = row.startedAt;
                }
            }
        }
        // Most expensive first — matches the "sorted by spend" heading and the
        // Cost column (a cheap high-token run must not outrank a costly one).
        return Array.from(byRun.values()).sort((a, b) => b.cost - a.cost);
    }, [rows, selectedModels, pricing]);

    if (!runs.length) return null;

    const limit = expanded ? CAP : INITIAL;
    const visible = runs.slice(0, limit);
    const cappedOut = expanded && runs.length > CAP ? runs.length - CAP : 0;

    return (
        <Card color="lv1">
            <CardHeader>
                <CardTitle className="text-sm">Review activity</CardTitle>
                <CardDescription className="text-xs">
                    {runs.length} review run{runs.length === 1 ? "" : "s"} in
                    the period, most expensive first.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-text-tertiary border-card-lv3 border-b text-left">
                            <th className="py-2 pr-4 font-medium">Review</th>
                            <th className="py-2 pr-4 font-medium">PR</th>
                            <th className="py-2 pr-4 font-medium">Started</th>
                            <th className="py-2 pr-4 font-medium">Models</th>
                            <th className="py-2 pr-4 text-right font-medium">
                                Tokens
                            </th>
                            <th className="py-2 text-right font-medium">
                                Cost
                            </th>
                        </tr>
                    </thead>
                    <tbody className="divide-card-lv3/60 divide-y">
                        {visible.map((run) => (
                            <tr key={run.review}>
                                <td className="text-text-secondary max-w-40 truncate py-2 pr-4 font-mono">
                                    {run.review}
                                </td>
                                <td className="text-text-primary py-2 pr-4 tabular-nums">
                                    {run.prNumber != null
                                        ? `#${run.prNumber}`
                                        : "—"}
                                </td>
                                <td className="text-text-secondary py-2 pr-4 whitespace-nowrap tabular-nums">
                                    {formatWhen(run.startedAt)}
                                </td>
                                <td className="text-text-secondary max-w-64 truncate py-2 pr-4">
                                    {run.models.join(", ")}
                                </td>
                                <td className="text-text-primary py-2 pr-4 text-right font-mono">
                                    {formatTokens(run.tokens)}
                                </td>
                                <td className="text-text-primary py-2 text-right font-mono">
                                    {formatUsd(run.cost)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {runs.length > INITIAL && (
                    <div className="mt-3 flex items-center justify-center gap-3">
                        <Button
                            size="xs"
                            variant="helper"
                            onClick={() => setExpanded((e) => !e)}>
                            {expanded
                                ? "Show less"
                                : `Show all (${Math.min(runs.length, CAP)})`}
                        </Button>
                        {cappedOut > 0 && (
                            <span className="text-text-tertiary text-xs">
                                Top {CAP} by spend · {cappedOut} more — narrow
                                the filters to see them.
                            </span>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
};
