"use client";

import { Heading } from "@components/ui/heading";
import { Label } from "@components/ui/label";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

const OPTIONS = [
    {
        name: "commentWhenMet",
        label: "Comment when every requirement is met",
        off: "Off: only the kody/business-logic check turns green.",
    },
    {
        name: "recheckOnPush",
        label: "Re-check on every push",
        off: "Off: Kody checks on the first review. Anyone can re-check with @kody -v business-logic, and the same comment is updated.",
    },
] as const;

/** What Kody does on the pull request (UC-26, UC-35). */
export const PrOptions = ({ canEdit }: { canEdit: boolean }) => {
    const form = useFormContext<CodeReviewFormType>();
    return (
        <section className="flex flex-col gap-3">
            <Heading variant="h3">On the pull request</Heading>
            <div className="bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y rounded-xl">
                {OPTIONS.map((option) => (
                    <Controller
                        key={option.name}
                        name={`businessLogic.${option.name}.value` as never}
                        control={form.control}
                        render={({ field }) => (
                            <div className="flex items-start gap-4 px-4 py-3">
                                <Switch
                                    id={`bl-${option.name}`}
                                    size="sm"
                                    className="mt-0.5"
                                    checked={Boolean(field.value)}
                                    disabled={!canEdit || field.disabled}
                                    onCheckedChange={field.onChange}
                                />
                                <div className="flex flex-col gap-0.5">
                                    <span className="flex items-center gap-2">
                                        <Label
                                            htmlFor={`bl-${option.name}`}
                                            className="text-text-primary cursor-pointer text-sm font-medium">
                                            {option.label}
                                        </Label>
                                        <OverrideIndicatorForm
                                            fieldName={`businessLogic.${option.name}`}
                                        />
                                    </span>
                                    <span className="text-text-secondary text-xs">
                                        {option.off}
                                    </span>
                                </div>
                            </div>
                        )}
                    />
                ))}
            </div>
        </section>
    );
};
