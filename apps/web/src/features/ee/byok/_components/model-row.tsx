"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import type { ByokModelCost } from "@services/usage/byok-cost";
import { formatUsd } from "@services/usage/format";
import {
    ArrowUpRightIcon,
    BrainCircuitIcon,
    CoinsIcon,
    KeyRoundIcon,
    LinkIcon,
    PencilIcon,
    ThermometerIcon,
    TrashIcon,
} from "lucide-react";
import Link from "next/link";

import curatedCatalog from "../_data/curated-models.json";
import type { CuratedModel } from "../_data/curated-models.types";
import type {
    BYOKConfigV2,
    BYOKModelConfig,
    LlmTask,
    ReasoningEffort,
} from "../_types";
import { maskKey, TASK_LABELS } from "../_utils";
import { PROVIDER_LABELS } from "./catalog/model-card";
import { DeleteRejectionAlert, useDeleteModel } from "./delete-model-flow";
import { ProviderLogo } from "./provider-logo";

const formatThinking = (effort?: ReasoningEffort): string | null => {
    if (!effort || effort === "none") return null;
    return effort.charAt(0).toUpperCase() + effort.slice(1);
};

const AMBER_TINT =
    "[--button-background:#2a1d10] [--button-foreground:var(--color-warning)]";

/**
 * A single model row inside a provider group. Shows a provider-tinted avatar,
 * the model's display name + benchmark, a subtle meta line (key mask, base URL,
 * thinking, temperature, accumulated cost) and a "USED IN" chip row derived from
 * the routing config (org default / per-task overrides / fallback). [Remove]
 * runs the 04-09 delete flow; a backend in-use rejection renders inline beneath
 * THIS row as a persistent Alert.
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

    const credential = (config?.credentials ?? []).find(
        (c) => c.id === model.credentialId,
    );
    const provider = credential?.provider;
    const providerLabel =
        curated?.providerDisplayName ??
        (provider ? PROVIDER_LABELS[provider] ?? provider : undefined);
    const settings = (credential?.settings ?? {}) as Record<string, unknown>;
    const baseURL =
        typeof settings.baseURL === "string" ? settings.baseURL : undefined;
    const keyMask = maskKey(credential?.apiKey);

    // "USED IN" — where routing points at THIS model slot (BYOKModelConfig.id).
    const routing = config?.routing;
    const isDefault = routing?.defaultModelId === model.id;
    const isFallback = routing?.fallbackModelId === model.id;
    const taskUsages = (
        Object.entries(routing?.taskOverrides ?? {}) as [LlmTask, string][]
    )
        .filter(([, id]) => id === model.id)
        .map(([task]) => TASK_LABELS[task] ?? task);
    const hasUsage = isDefault || isFallback || taskUsages.length > 0;

    const { confirmAndDelete, rejectionReasons } = useDeleteModel({
        config,
        model,
        onDeleted,
    });

    return (
        <div className="flex flex-col">
            <div className="border-card-lv2 flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                        <ProviderLogo
                            provider={provider}
                            label={providerLabel ?? displayName}
                            className="mt-0.5 size-8"
                        />
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
                            {providerLabel && (
                                <span className="text-text-tertiary text-xs">
                                    {providerLabel}
                                </span>
                            )}

                            <div className="text-text-secondary flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                {keyMask && (
                                    <span className="flex items-center gap-1.5 font-mono">
                                        <KeyRoundIcon size={12} />
                                        {keyMask}
                                    </span>
                                )}
                                {baseURL && (
                                    <span className="flex items-center gap-1.5 font-mono break-all">
                                        <LinkIcon size={12} />
                                        {baseURL}
                                    </span>
                                )}
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
                                                    <ArrowUpRightIcon
                                                        size={11}
                                                    />
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

                {hasUsage && (
                    <div className="border-card-lv2 flex flex-wrap items-center gap-2 border-t pt-2.5">
                        <span className="text-text-tertiary text-[10px] font-semibold tracking-wider uppercase">
                            Used in
                        </span>
                        {isDefault && (
                            <Badge size="xs" className={AMBER_TINT}>
                                Org default
                            </Badge>
                        )}
                        {taskUsages.map((label) => (
                            <Badge key={label} size="xs" variant="success">
                                {label}
                            </Badge>
                        ))}
                        {isFallback && (
                            <Badge size="xs" variant="secondary">
                                Fallback
                            </Badge>
                        )}
                    </div>
                )}
            </div>

            <DeleteRejectionAlert
                modelName={displayName}
                reasons={rejectionReasons}
            />
        </div>
    );
}
