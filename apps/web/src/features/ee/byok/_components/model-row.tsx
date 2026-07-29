"use client";

import { Button } from "@components/ui/button";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { formatUsd } from "@services/usage/format";
import {
    ArrowUpRightIcon,
    BrainCircuitIcon,
    CheckCircle2Icon,
    CoinsIcon,
    PencilIcon,
    ThermometerIcon,
    TrashIcon,
} from "lucide-react";
import Link from "next/link";

import curatedCatalog from "../_data/curated-models.json";
import type { CuratedModel } from "../_data/curated-models.types";
import type { BYOKConfigV2, BYOKModelConfig, ReasoningEffort } from "../_types";
import { DeleteRejectionAlert, useDeleteModel } from "./delete-model-flow";

const formatThinking = (effort?: ReasoningEffort): string | null => {
    if (!effort || effort === "none") return null;
    return effort.charAt(0).toUpperCase() + effort.slice(1);
};

/**
 * A single model row inside a provider group. Shows the model's display name,
 * benchmark score, thinking/temperature and accumulated cost — but NEVER the
 * key or base URL: those are provider-scoped and live on the group header now
 * (SLICE 2). [Remove] runs the 04-09 delete flow (confirm → deleteBYOK); when the
 * backend rejects an in-use model, the reason list renders as a persistent inline
 * Alert directly beneath THIS row so it sits with the model it blocks.
 */
export function ModelRow({
    model,
    config,
    cost,
    periodLabel,
    costRangeQuery,
    onEdit,
    onDeleted,
}: {
    model: BYOKModelConfig;
    config?: BYOKConfigV2 | null;
    cost?: ByokModelCost;
    periodLabel?: string;
    costRangeQuery?: string;
    onEdit?: () => void;
    onDeleted?: () => void;
}) {
    const curated = (curatedCatalog.models as CuratedModel[]).find(
        (m) => m.id === model.model,
    );
    const displayName = curated?.displayName ?? model.model;
    const thinking = formatThinking(model.reasoningEffort);

    const { confirmAndDelete, rejectionReasons } = useDeleteModel({
        config,
        model,
        onDeleted,
    });

    return (
        <div className="flex flex-col">
        <div className="border-card-lv2 flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="flex min-w-0 items-start gap-3">
                <span className="bg-success/15 text-success mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full">
                    <CheckCircle2Icon size={14} />
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                    <span className="text-text-primary text-sm font-semibold text-balance">
                        {displayName}
                        {curated && (
                            <span className="text-text-tertiary ml-2 text-xs font-normal">
                                ★{" "}
                                <span className="tabular-nums">
                                    {curated.benchmarkScore}
                                </span>
                            </span>
                        )}
                    </span>

                    <div className="text-text-secondary flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        {thinking && (
                            <span className="flex items-center gap-1.5">
                                <BrainCircuitIcon size={12} /> Thinking:{" "}
                                {thinking}
                            </span>
                        )}
                        {model.temperature != null && (
                            <span className="flex items-center gap-1.5">
                                <ThermometerIcon size={12} /> Temp:{" "}
                                <span className="tabular-nums">
                                    {model.temperature}
                                </span>
                            </span>
                        )}
                        {cost && (
                            <span className="flex items-center gap-1.5">
                                <CoinsIcon size={12} />
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
                                            <span className="text-text-tertiary">
                                                · {periodLabel}
                                            </span>
                                        )}
                                        <span className="text-primary-light inline-flex items-center gap-1 group-hover:underline">
                                            View breakdown
                                            <ArrowUpRightIcon size={11} />
                                        </span>
                                    </Link>
                                ) : (
                                    <span className="text-text-tertiary">
                                        {cost.reason === "unpriced"
                                            ? "No catalog price"
                                            : "No usage in this period"}
                                    </span>
                                )}
                            </span>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
                {onEdit && (
                    <Button
                        size="xs"
                        variant="helper"
                        leftIcon={<PencilIcon />}
                        onClick={onEdit}>
                        Edit
                    </Button>
                )}
                {onDeleted && (
                    <Button
                        size="xs"
                        variant="cancel"
                        leftIcon={<TrashIcon />}
                        className="text-danger [--button-foreground:var(--color-danger)]"
                        onClick={confirmAndDelete}>
                        Remove
                    </Button>
                )}
            </div>
        </div>

            <DeleteRejectionAlert
                modelName={displayName}
                reasons={rejectionReasons}
            />
        </div>
    );
}
