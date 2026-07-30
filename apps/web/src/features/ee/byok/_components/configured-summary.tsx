"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Separator } from "@components/ui/separator";
import {
    BrainCircuitIcon,
    CheckCircle2Icon,
    CoinsIcon,
    ArrowUpRightIcon,
    KeyRoundIcon,
    LinkIcon,
    PencilIcon,
    ThermometerIcon,
    TrashIcon,
} from "lucide-react";
import Link from "next/link";

import type { ByokModelCost } from "@services/usage/byok-cost";
import { formatUsd } from "@services/usage/format";

import curatedCatalog from "../_data/curated-models.json";
import type { CuratedModel } from "../_data/curated-models.types";
import type { BYOKConfig } from "../_types";
import { maskKey } from "../_utils";
import { PROVIDER_LABELS } from "./catalog/model-card";

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString();
}

const formatReasoning = (config: BYOKConfig): string | null => {
    if (!config.reasoningEffort || config.reasoningEffort === "none")
        return null;
    if (config.reasoningConfigOverride) return "Custom";
    return (
        config.reasoningEffort.charAt(0).toUpperCase() +
        config.reasoningEffort.slice(1)
    );
};

export function ConfiguredSummary({
    config,
    onChange,
    onDelete,
    isDeleting,
    cost,
    periodLabel,
    costRangeQuery,
}: {
    config: BYOKConfig;
    onChange: () => void;
    onDelete: () => void;
    isDeleting?: boolean;
    /**
     * Accumulated cost of this model (see resolveByokModelCost). When absent
     * or `no-data`, the block explains why instead of showing a misleading $0.
     */
    cost?: ByokModelCost;
    /** e.g. "last 14 days" — tells the user which window the cost covers. */
    periodLabel?: string;
    /** `start=..&end=..` so the Costs deep-link opens on the SAME window. */
    costRangeQuery?: string;
}) {
    const curated = (curatedCatalog.models as CuratedModel[]).find(
        (m) => m.id === config.model,
    );
    const displayName = curated?.displayName ?? config.model;
    const providerLabel =
        curated?.providerDisplayName ??
        PROVIDER_LABELS[config.provider] ??
        config.provider;
    const reasoningLabel = formatReasoning(config);

    return (
        <Card color="lv1">
            <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                    <span className="bg-success/15 text-success flex size-8 items-center justify-center rounded-full">
                        <CheckCircle2Icon size={16} />
                    </span>
                    <div className="flex flex-col">
                        <span className="text-text-primary text-base font-semibold text-balance">
                            {displayName}
                        </span>
                        <span className="text-text-tertiary text-xs">
                            {providerLabel}
                            {curated && (
                                <>
                                    {" · ★ "}
                                    <span className="tabular-nums">
                                        {curated.benchmarkScore}
                                    </span>
                                </>
                            )}
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <Button
                        size="xs"
                        variant="helper"
                        leftIcon={<PencilIcon />}
                        onClick={onChange}>
                        Change
                    </Button>
                    <Button
                        size="xs"
                        variant="cancel"
                        leftIcon={<TrashIcon />}
                        loading={isDeleting}
                        className="text-danger [--button-foreground:var(--color-danger)]"
                        onClick={onDelete}>
                        Remove
                    </Button>
                </div>
            </CardHeader>

            <CardContent>
                <Separator className="bg-card-lv2 mb-3" />

                <dl className="text-text-secondary grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
                    <dt className="flex items-center gap-1.5">
                        <KeyRoundIcon size={12} /> Key
                    </dt>
                    <dd className="font-mono text-xs">
                        {maskKey(config.apiKey)}
                    </dd>

                    {config.baseURL && (
                        <>
                            <dt className="flex items-center gap-1.5">
                                <LinkIcon size={12} /> Base URL
                            </dt>
                            <dd className="font-mono text-xs break-all">
                                {config.baseURL}
                            </dd>
                        </>
                    )}

                    {reasoningLabel && (
                        <>
                            <dt className="flex items-center gap-1.5">
                                <BrainCircuitIcon size={12} /> Thinking
                            </dt>
                            <dd>{reasoningLabel}</dd>
                        </>
                    )}

                    {config.temperature != null && (
                        <>
                            <dt className="flex items-center gap-1.5">
                                <ThermometerIcon size={12} /> Temperature
                            </dt>
                            <dd>{config.temperature}</dd>
                        </>
                    )}

                    {cost && (
                        <>
                            <dt className="flex items-center gap-1.5">
                                <CoinsIcon size={12} /> Cost
                            </dt>
                            <dd>
                                {cost.status === "ok" ? (
                                    <Link
                                        href={`/token-usage?models=${encodeURIComponent(
                                            cost.model,
                                        )}${
                                            costRangeQuery
                                                ? `&${costRangeQuery}`
                                                : ""
                                        }`}
                                        title="See the full breakdown on the Costs page"
                                        className="group inline-flex items-center gap-1.5 rounded-sm tabular-nums focus-visible:ring-2">
                                        <span className="text-text-primary font-semibold">
                                            {formatUsd(cost.total)}
                                        </span>
                                        {periodLabel && (
                                            <span className="text-text-tertiary text-xs">
                                                · {periodLabel}
                                            </span>
                                        )}
                                        <span className="text-primary-light inline-flex items-center gap-1 text-xs group-hover:underline">
                                            View breakdown
                                            <ArrowUpRightIcon size={11} />
                                        </span>
                                    </Link>
                                ) : (
                                    <span className="text-text-tertiary text-xs">
                                        {cost.reason === "unpriced"
                                            ? "No catalog price — set a manual price below"
                                            : "No usage in this period"}
                                    </span>
                                )}
                            </dd>
                        </>
                    )}
                </dl>
            </CardContent>
        </Card>
    );
}
