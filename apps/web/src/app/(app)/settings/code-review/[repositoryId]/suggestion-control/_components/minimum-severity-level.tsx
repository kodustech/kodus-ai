import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { magicModal } from "@components/ui/magic-modal";
import { SliderWithMarkers } from "@components/ui/slider-with-markers";
import { InfoIcon } from "lucide-react";
import { Controller, useFormContext } from "react-hook-form";
import type { SeverityLevel } from "src/core/types";
import { cn } from "src/core/utils/components";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";
import { SeverityLevelsExplanationModal } from "./security-levels-explanation-modal";

const severityLevelFilterOptions = {
    low: { label: "Low/All", value: 0 },
    medium: { label: "Medium", value: 1 },
    high: { label: "High", value: 2 },
    critical: { label: "Critical", value: 3 },
} satisfies Record<SeverityLevel, { label: string; value: number }>;

export const MinimumSeverityLevel = () => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <div className="flex flex-col gap-3">
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
                    const numberValue = severityLevel?.value;

                    return (
                        <div className="mt-6">
                            <div className="mb-2 flex flex-row items-center gap-2">
                                <Heading variant="h2">
                                    Minimum severity level
                                </Heading>
                                <OverrideIndicatorForm
                                    fieldName="suggestionControl.severityLevelFilter"
                                    className="mb-2"
                                />
                            </div>
                            <small className="text-text-secondary text-sm">
                                Select the minimum severity level for Kody to
                                post code review suggestions
                            </small>
                            <FormControl.Root>
                                <FormControl.Input>
                                    <div className="relative mt-3 w-96">
                                        <SliderWithMarkers
                                            id={field.name}
                                            min={0}
                                            max={3}
                                            step={1}
                                            labels={labels}
                                            value={numberValue}
                                            disabled={field.disabled}
                                            onValueChange={(value) =>
                                                field.onChange(
                                                    Object.entries(
                                                        severityLevelFilterOptions,
                                                    ).find(
                                                        ([, v]) =>
                                                            v.value === value,
                                                    )?.[0],
                                                )
                                            }
                                            className={cn({
                                                "[--slider-marker-background-active:#119DE4]":
                                                    field.value === "low",
                                                "[--slider-marker-background-active:#115EE4]":
                                                    field.value === "medium",
                                                "[--slider-marker-background-active:#6A57A4]":
                                                    field.value === "high",
                                                "[--slider-marker-background-active:#EF4B4B]":
                                                    field.value === "critical",
                                            })}
                                        />
                                    </div>
                                </FormControl.Input>

                                <FormControl.Error>
                                    {fieldState.error?.message}
                                </FormControl.Error>

                                <FormControl.Helper>
                                    Kody will provide suggestions with severity
                                    from{" "}
                                    <strong key={severityLevel.label}>
                                        {severityLevel.label}
                                    </strong>{" "}
                                    and higher
                                </FormControl.Helper>
                            </FormControl.Root>
                        </div>
                    );
                }}
            />
        </div>
    );
};
