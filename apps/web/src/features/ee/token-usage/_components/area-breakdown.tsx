"use client";

import { useMemo } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { UsageByAreaResultContract } from "@services/usage/types";

import { CHART_COLORS } from "../../cockpit/_components/charts/recharts-shared";

/**
 * Human labels, display color and a plain-language description for the fixed
 * TokenUsageArea set (see libs/core/log/token-usage-tu.ts). The description
 * powers the hover tooltip — "area of the review process" is internal jargon,
 * so each row explains what actually spent the tokens. Unknown values fall
 * through to "Other".
 */
const AREA_META: Record<
    string,
    { label: string; color: string; description: string }
> = {
    review: {
        label: "Code review agents",
        color: CHART_COLORS.info,
        description:
            "The main review agents that read the diff and find issues — usually the bulk of every review.",
    },
    kody_rules: {
        label: "Kody Rules",
        color: CHART_COLORS.primary,
        description:
            "Checking the diff against your Kody Rules and generating rule-based findings.",
    },
    cross_file: {
        label: "Cross-file context",
        color: CHART_COLORS.purple,
        description:
            "Pulling related code from other files so the review agents have wider context than just the diff.",
    },
    suggestions: {
        label: "Suggestion refinement",
        color: CHART_COLORS.success,
        description:
            "Polishing raw findings before they're posted — severity, deduplication, simplicity and safeguard checks.",
    },
    summary: {
        label: "PR summary",
        color: CHART_COLORS.warning,
        description: "Writing the PR summary comment.",
    },
    conversation: {
        label: "Conversation",
        color: CHART_COLORS.danger,
        description: "Answering your @kody replies in review threads.",
    },
    system: {
        label: "System analysis",
        color: CHART_COLORS.muted,
        description:
            "Internal steps like picking the review mode or validating implemented suggestions — not review output itself.",
    },
    other: {
        label: "Other",
        color: CHART_COLORS.muted,
        description:
            "Steps not attributed to a specific review phase (e.g. issue resolution, external-reference detection).",
    },
};

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1000000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1000000).toFixed(1)}M`;
};

const rawPct = (value: number, total: number) =>
    total > 0 ? (value / total) * 100 : 0;

// Label: distinguish a true zero from a share too small to round to 0.1%.
// Showing "0.0%" on a row that actually spent tokens reads as "nothing".
const pctLabel = (value: number, total: number) => {
    const p = rawPct(value, total);
    if (p === 0) return "0%";
    if (p < 0.1) return "<0.1%";
    return `${p.toFixed(1)}%`;
};

// Bar width keeps the real fraction (CSS-safe) so a tiny area still renders a
// sliver instead of vanishing.
const barWidth = (value: number, total: number) => `${rawPct(value, total)}%`;

/**
 * "Where tokens go" — spend per area of the review process. Rows arrive
 * per area+model; collapse them per area and render share bars.
 */
export const AreaBreakdown = ({
    rows,
    selectedModels,
}: {
    rows: UsageByAreaResultContract[];
    selectedModels: string[];
}) => {
    const areas = useMemo(() => {
        const selected = new Set(selectedModels);
        const byArea = new Map<string, number>();
        for (const row of rows) {
            if (!selected.has(row.model)) continue;
            // Collapse any area without a known label into the single 'other'
            // bucket BEFORE summing — otherwise two unmapped raw values would
            // render as separate bars both labeled "Other", splitting the
            // share and token total.
            const area = AREA_META[row.area] ? row.area : "other";
            byArea.set(area, (byArea.get(area) ?? 0) + row.total);
        }
        return Array.from(byArea.entries())
            .map(([area, total]) => ({
                area,
                total,
                meta: AREA_META[area],
            }))
            .sort((a, b) => b.total - a.total);
    }, [rows, selectedModels]);

    const grandTotal = areas.reduce((sum, a) => sum + a.total, 0);

    if (!areas.length) return null;

    return (
        <Card color="lv1">
            <CardHeader>
                <CardTitle className="text-sm">Where tokens go</CardTitle>
                <CardDescription className="text-xs">
                    Token spend by area of the review process in the selected
                    period.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                {areas.map(({ area, total, meta }) => (
                    <div key={area} className="flex items-center gap-3">
                        <span
                            className="size-2 shrink-0 rounded-xs"
                            style={{ backgroundColor: meta.color }}
                        />
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="text-text-secondary w-44 shrink-0 cursor-help truncate text-xs underline decoration-dotted decoration-from-font underline-offset-4">
                                    {meta.label}
                                </span>
                            </TooltipTrigger>
                            <TooltipContent className="text-text-primary max-w-64 text-pretty">
                                {meta.description}
                            </TooltipContent>
                        </Tooltip>
                        <div className="bg-card-lv2 h-2 min-w-0 flex-1 overflow-hidden rounded-full">
                            <div
                                className="h-full rounded-full"
                                style={{
                                    width: barWidth(total, grandTotal),
                                    backgroundColor: meta.color,
                                }}
                            />
                        </div>
                        <span className="text-text-primary w-16 shrink-0 text-right font-mono text-xs font-semibold">
                            {formatTokens(total)}
                        </span>
                        <span className="text-text-tertiary w-12 shrink-0 text-right font-mono text-xs">
                            {pctLabel(total, grandTotal)}
                        </span>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
};
