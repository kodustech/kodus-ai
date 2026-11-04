"use client";

import { Badge } from "@components/ui/badge";
import { Label } from "@components/ui/label";
import { Link } from "@components/ui/link";
import { RadioGroup } from "@components/ui/radio-group";
import { ArrowUpRightIcon } from "lucide-react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import {
    useCodeReviewConfig,
    useCodeReviewModelData,
} from "src/app/(app)/settings/_components/context";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";
import { formatModelLabel } from "src/features/ee/byok/_data/model-label";
import {
    HEAVY_MODE_PLAN_TAG,
    isHeavyModePlan,
} from "src/features/ee/heavy-mode/plan";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import type { CodeReviewFormType } from "../../../_types";

type Mode = "balanced" | "heavy";

const MODES: { value: Mode; title: string; description: string }[] = [
    {
        value: "balanced",
        title: "Balanced",
        description: "The standard review.",
    },
    {
        value: "heavy",
        title: "Heavy",
        description:
            "A deeper review: nine specialist reviewers run next to the main one, at the cost of more model calls.",
    },
];

const ROUTING_HREF = "/byok?tab=routing";

/**
 * The review mode pull requests get, and the model each mode runs on. The
 * models are read-only here: they are the organization's routing (edited in
 * the Routing tab), unless this repository or directory sets its own model,
 * which then runs both modes.
 */
export const ReviewMode = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    // Heavy runs on Teams and Enterprise only; elsewhere it shows, disabled.
    const heavyAllowed = isHeavyModePlan(useSubscriptionContext().license);

    return (
        <Controller
            name="reviewMode.value"
            control={form.control}
            defaultValue={config?.reviewMode?.value ?? "balanced"}
            render={({ field }) => (
                <div className="flex min-w-0 flex-col gap-4 px-5 py-4 sm:px-6">
                    <div className="flex flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-text-primary text-sm leading-5 font-medium">
                                Review mode
                            </span>
                            <OverrideIndicatorForm fieldName="reviewMode" />
                        </div>
                        <p className="text-text-secondary text-xs leading-5">
                            How deep Kody reviews pull requests. A review
                            command can still ask for the other mode with{" "}
                            <code>--heavy</code> or <code>--balanced</code>.
                        </p>
                    </div>

                    <RadioGroup.Root
                        value={(field.value as Mode) ?? "balanced"}
                        onValueChange={field.onChange}
                        disabled={field.disabled}
                        className="grid gap-2 sm:grid-cols-2">
                        {MODES.map((mode) => {
                            const locked =
                                mode.value === "heavy" && !heavyAllowed;
                            return (
                                <Label
                                    key={mode.value}
                                    aria-disabled={locked || undefined}
                                    className={
                                        locked
                                            ? "bg-card-lv2 flex cursor-not-allowed items-start gap-3 rounded-xl border border-transparent px-4 py-3 opacity-60"
                                            : "bg-card-lv2 has-[[data-state=checked]]:border-primary-light flex cursor-pointer items-start gap-3 rounded-xl border border-transparent px-4 py-3"
                                    }>
                                    <RadioGroup.Item
                                        value={mode.value}
                                        disabled={locked}
                                        className="mt-0.5"
                                    />
                                    <span className="flex flex-col">
                                        <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                                            {mode.title}
                                            {locked && (
                                                <Badge>
                                                    {HEAVY_MODE_PLAN_TAG}
                                                </Badge>
                                            )}
                                        </span>
                                        <span className="text-text-secondary text-xs">
                                            {mode.description}
                                        </span>
                                    </span>
                                </Label>
                            );
                        })}
                    </RadioGroup.Root>

                    <ReviewModels
                        selected={(field.value as Mode) ?? "balanced"}
                    />
                </div>
            )}
        />
    );
};

const ReviewModels = ({ selected }: { selected: Mode }) => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();
    const { llmConfigStatus } = useCodeReviewModelData();

    // The model this repository or directory sets (General → model), as on
    // screen: it runs both modes.
    const scopeModelId =
        useWatch({ control: form.control, name: "byokModelId.value" }) ||
        config?.byokModelId?.value ||
        config?.byokModel?.value ||
        "";

    const reviewModels = llmConfigStatus?.reviewModels;
    const models = llmConfigStatus?.models ?? [];

    // No BYOK config: reviews run on the Kodus-managed model, nothing to show.
    if (!llmConfigStatus?.byok?.configured || !reviewModels) {
        return null;
    }

    const labelOf = (id?: string) => {
        const model = models.find((m) => m.modelId === id || m.model === id);
        return model ? formatModelLabel(model.model ?? model.modelId) : id;
    };

    const header = (
        <div className="border-card-lv3/60 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <span className="text-text-primary text-sm font-medium">
                Review models
            </span>
            <Link
                href={ROUTING_HREF}
                className="text-text-secondary inline-flex items-center gap-1 text-xs">
                View organization routing
                <ArrowUpRightIcon className="size-3" />
            </Link>
        </div>
    );

    if (models.length < 2) {
        return (
            <div className="flex flex-col gap-2">
                {header}
                <p className="text-text-secondary text-xs leading-5">
                    Both modes use {labelOf(models[0]?.modelId)}, your only
                    connected model. Connect a second model to pick a different
                    one for each mode in Routing.
                </p>
            </div>
        );
    }

    if (scopeModelId) {
        return (
            <div className="flex flex-col gap-2">
                {header}
                <p className="text-text-secondary text-xs leading-5">
                    Both modes use {labelOf(scopeModelId)}, the model set for
                    this scope below. Clear it to use the organization routing.
                </p>
            </div>
        );
    }

    const rows: { mode: Mode; title: string }[] = [
        { mode: "balanced", title: "Balanced" },
        { mode: "heavy", title: "Heavy" },
    ];

    return (
        <div className="flex flex-col gap-2">
            {header}
            <div className="divide-card-lv3/60 flex flex-col divide-y">
                {rows.map(({ mode, title }) => {
                    const { modelId, inherited } = reviewModels[mode];
                    return (
                        <div
                            key={mode}
                            className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <span className="flex items-center gap-2">
                                <span className="text-text-primary text-sm">
                                    {title}
                                </span>
                                {selected === mode && <Badge>In use</Badge>}
                            </span>
                            <span className="flex flex-col items-end">
                                <span className="text-text-primary text-sm">
                                    {inherited
                                        ? `Organization default · ${labelOf(modelId)}`
                                        : labelOf(modelId)}
                                </span>
                                <span className="text-text-tertiary text-xs">
                                    Organization routing
                                </span>
                            </span>
                        </div>
                    );
                })}
            </div>
            <p className="text-text-tertiary text-xs">
                Selected mode: {selected === "heavy" ? "Heavy" : "Balanced"} ·
                Model: {labelOf(reviewModels[selected].modelId)}
            </p>
        </div>
    );
};
