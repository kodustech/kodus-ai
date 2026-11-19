"use client";

import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { ChevronsUpDownIcon } from "lucide-react";
import { ProviderAvatar } from "src/features/ee/byok/_components/provider-avatar";
import {
    ModelCombobox,
    type PoolModel,
} from "src/features/ee/byok/_components/routing/task-override-grid";
import { HEAVY_MODE_PLAN_TAG } from "src/features/ee/heavy-mode/plan";

import { ULTRA_MODEL_COUNT } from "./plan";

/**
 * The Ultra models of the organization: three different models, each running
 * a full heavy review, merged into one. Locked on a plan without Ultra, and
 * disabled with fewer than three models of the team's own. A trio not yet
 * complete blocks the save through the card's validation alert.
 */
export function UltraModelsRow({
    pool,
    ultraModelIds,
    fallbackModelId,
    planAllowed,
    editable,
    onSelect,
}: {
    pool: PoolModel[];
    ultraModelIds?: string[];
    fallbackModelId?: string;
    planAllowed: boolean;
    editable: boolean;
    onSelect: (index: number, id?: string) => void;
}) {
    const usable = pool.filter((model) => !model.disabled);
    const enough = usable.length >= ULTRA_MODEL_COUNT;
    const slots = Array.from(
        { length: ULTRA_MODEL_COUNT },
        (_, i) => ultraModelIds?.[i] || undefined,
    );
    const fallback = pool.find((model) => model.id === fallbackModelId);
    const fallbackInTrio = !!fallbackModelId && slots.includes(fallbackModelId);

    return (
        <div
            data-routing-anchor="ultra"
            className="grid items-start gap-3 py-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div>
                <p className="flex flex-wrap items-center gap-2 pt-2.5">
                    Ultra models
                    {!planAllowed && (
                        <Badge variant="helper">{HEAVY_MODE_PLAN_TAG}</Badge>
                    )}
                </p>
                <p className="text-text-secondary mt-1 text-xs">
                    Each runs a full Heavy review; the results are merged into
                    one.
                </p>
            </div>
            {!planAllowed ? (
                <div className="border-card-lv3 bg-card-lv2 flex max-w-xl flex-col gap-1 rounded-lg border border-dashed p-3">
                    <p className="font-medium">
                        Ultra runs a full Heavy review on three of your models
                        and merges them into one.
                    </p>
                    <p className="text-text-secondary">
                        Different models catch different bugs: on our benchmark,
                        three-model trios find more bugs than any single model.
                    </p>
                    <Link href="/settings/subscription" className="text-sm">
                        See plans ↗
                    </Link>
                </div>
            ) : (
                <div className="flex min-w-0 flex-col gap-2">
                    {slots.map((id, index) => {
                        const model = pool.find((m) => m.id === id);
                        const label = `Model ${index + 1}`;
                        const options = pool.map((m) =>
                            m.id !== id && slots.includes(m.id)
                                ? {
                                      ...m,
                                      disabled: true,
                                      disabledReason: "Already selected.",
                                  }
                                : m,
                        );
                        const disabled = !editable || (!enough && !id);
                        return (
                            <div
                                key={label}
                                className="grid items-center gap-2 sm:grid-cols-[minmax(0,20rem)_auto]">
                                <ModelCombobox
                                    models={options}
                                    value={id}
                                    gateTask="codeReviewHeavy"
                                    disabled={disabled}
                                    onSelect={(next) => onSelect(index, next)}
                                    defaultOption={{
                                        label: "None",
                                        selected: !id,
                                        onSelect: () => onSelect(index),
                                    }}
                                    trigger={
                                        <Button
                                            type="button"
                                            size="md"
                                            variant="helper"
                                            role="combobox"
                                            aria-label={`Ultra ${label}`}
                                            disabled={disabled}
                                            className="w-full justify-between"
                                            rightIcon={
                                                <ChevronsUpDownIcon className="opacity-50" />
                                            }>
                                            <span className="flex min-w-0 items-center gap-2">
                                                <ProviderAvatar
                                                    provider={model?.provider}
                                                />
                                                <span className="truncate">
                                                    {model?.label ??
                                                        (id
                                                            ? "Unavailable model"
                                                            : "Select a model")}
                                                </span>
                                            </span>
                                        </Button>
                                    }
                                />
                                <span className="text-text-secondary text-xs font-medium">
                                    {label}
                                </span>
                            </div>
                        );
                    })}
                    {!enough ? (
                        <p className="text-text-secondary text-xs">
                            Ultra needs at least three of your own models. You
                            have {usable.length}.{" "}
                            <Link href="/byok" className="text-xs">
                                Add models in AI providers ↗
                            </Link>
                        </p>
                    ) : (
                        <p className="text-text-secondary text-xs">
                            Three different models. Cost is about the sum of
                            three Heavy reviews.
                        </p>
                    )}
                    {fallbackInTrio && (
                        <p className="text-warning text-xs">
                            The fallback, {fallback?.label ?? "your fallback"},
                            is also an Ultra model: if another model fails, its
                            review counts once and Ultra runs with fewer models.
                            Pick a fallback outside the three.
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
