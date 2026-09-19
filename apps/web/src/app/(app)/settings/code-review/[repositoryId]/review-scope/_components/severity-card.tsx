"use client";

import { Card, CardContent, CardHeader } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { SliderWithMarkers } from "@components/ui/slider-with-markers";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { cn } from "src/core/utils/components";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";
import { severityLevelFilterOptions } from "../../suggestion-control/_components/minimum-severity-level";

/**
 * The severity threshold and whether it also applies to Kody Rules, in one
 * card: the toggle only makes sense next to the slider it modifies.
 */
export const SeverityCard = () => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-col gap-1">
                    <div className="flex flex-row items-center gap-2">
                        <Heading variant="h3">Minimum severity to post</Heading>
                        <OverrideIndicatorForm fieldName="suggestionControl.severityLevelFilter" />
                    </div>
                    <p className="text-text-secondary text-sm">
                        Kody still finds lower-severity issues; it just does not
                        comment on them.
                    </p>
                </div>
            </CardHeader>
            <CardContent data-field-name="suggestionControl.severityLevelFilter">
                <Controller
                    name="suggestionControl.severityLevelFilter.value"
                    control={form.control}
                    render={({ field, fieldState }) => {
                        const labels = Object.values(
                            severityLevelFilterOptions,
                        ).map((option) => option.label);
                        const severityLevel =
                            severityLevelFilterOptions[field.value!] ??
                            severityLevelFilterOptions.low;

                        return (
                            <FormControl.Root>
                                <FormControl.Input>
                                    <div className="relative w-full max-w-md">
                                        <SliderWithMarkers
                                            id={field.name}
                                            min={0}
                                            max={3}
                                            step={1}
                                            labels={labels}
                                            value={severityLevel.value}
                                            disabled={field.disabled}
                                            onValueChange={(value) =>
                                                field.onChange(
                                                    Object.entries(
                                                        severityLevelFilterOptions,
                                                    ).find(
                                                        ([, option]) =>
                                                            option.value ===
                                                            value,
                                                    )?.[0],
                                                )
                                            }
                                            className={cn({
                                                "[--slider-marker-background-active:var(--color-info)]":
                                                    field.value === "low",
                                                "[--slider-marker-background-active:var(--color-alert)]":
                                                    field.value === "medium",
                                                "[--slider-marker-background-active:var(--color-warning)]":
                                                    field.value === "high",
                                                "[--slider-marker-background-active:var(--color-danger)]":
                                                    field.value === "critical",
                                            })}
                                        />
                                    </div>
                                </FormControl.Input>
                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>
                                <FormControl.Helper>
                                    Posting suggestions from{" "}
                                    <strong>{severityLevel.label}</strong> and
                                    higher.
                                </FormControl.Helper>
                            </FormControl.Root>
                        );
                    }}
                />
            </CardContent>

            <Controller
                name="suggestionControl.applyFiltersToKodyRules.value"
                control={form.control}
                render={({ field }) => (
                    <label
                        className="border-card-lv3/60 flex cursor-pointer items-center justify-between gap-6 border-t px-6 py-4"
                        data-field-name="suggestionControl.applyFiltersToKodyRules">
                        <span className="flex flex-col gap-0.5">
                            <span className="text-text-primary flex items-center gap-2 text-sm font-medium">
                                Apply the threshold to Kody Rules
                                <OverrideIndicatorForm fieldName="suggestionControl.applyFiltersToKodyRules" />
                            </span>
                            <span className="text-text-secondary text-xs">
                                Off means Kody Rules suggestions are posted at
                                any severity.
                            </span>
                        </span>
                        <Switch
                            size="sm"
                            checked={Boolean(field.value)}
                            disabled={field.disabled}
                            onCheckedChange={field.onChange}
                        />
                    </label>
                )}
            />
        </Card>
    );
};
