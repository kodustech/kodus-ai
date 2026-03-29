"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";

import {
    filterVisibleReviewLabels,
    mergeMissingReviewOptions,
} from "../_utils/review-options-state";
import { OverrideIndicatorForm } from "../../../_components/override";
import { type CodeReviewFormType } from "../../../_types";

interface CheckboxCardOption {
    value: string;
    name: string;
    description: string;
}

export const AnalysisTypes = () => {
    const currentLevel = useCurrentConfigLevel();
    const { businessLogic } = useFeatureFlags();
    const form = useFormContext<CodeReviewFormType>();
    const codeReviewVersion =
        useWatch({
            control: form.control,
            name: "codeReviewVersion.value",
        }) || "v2";
    const reviewOptions = useWatch({
        control: form.control,
        name: "reviewOptions",
    });
    const { data: labels = [], isLoading } =
        useGetCodeReviewLabels(codeReviewVersion);
    const isBusinessLogicEnabled = businessLogic === true;
    const visibleLabels = useMemo(
        () => filterVisibleReviewLabels(labels, isBusinessLogicEnabled),
        [isBusinessLogicEnabled, labels],
    );
    const visibleLabelTypes = useMemo(
        () => visibleLabels.map((label) => label.type),
        [visibleLabels],
    );

    const reviewOptionsOptions: CheckboxCardOption[] = visibleLabels.map(
        (label) => ({
            value: label.type,
            name: label.name,
            description: label.description,
        }),
    );

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="text-text-secondary">Loading categories...</div>
            </div>
        );
    }

    return (
        <Controller
            name="reviewOptions"
            control={form.control}
            render={({ field }) => {
                const normalizedOptions = mergeMissingReviewOptions(
                    (field.value || reviewOptions || {}) as Record<
                        string,
                        { value: boolean; level: typeof currentLevel }
                    >,
                    visibleLabelTypes,
                );

                return (
                    <FormControl.Root className="@container space-y-1">
                        <FormControl.Input>
                            <ToggleGroup.Root
                                id={field.name}
                                type="multiple"
                                disabled={field.disabled}
                                className="grid auto-rows-fr grid-cols-1 gap-2 @lg:grid-cols-2 @3xl:grid-cols-3"
                                value={Object.entries(normalizedOptions)
                                    .filter(([, prop]) => prop.value)
                                    .map(([key]) => key)}
                                onValueChange={(values) => {
                                    const updatedOptions = {
                                        ...normalizedOptions,
                                    };

                                    visibleLabelTypes.forEach((option) => {
                                        const isSelected =
                                            values.includes(option);
                                        const existingOption =
                                            updatedOptions[option];

                                        if (existingOption) {
                                            updatedOptions[option] = {
                                                ...existingOption,
                                                value: isSelected,
                                                level: currentLevel,
                                            };
                                        } else {
                                            updatedOptions[option] = {
                                                value: isSelected,
                                                level: currentLevel,
                                            };
                                        }
                                    });

                                    field.onChange(updatedOptions);
                                }}>
                                {reviewOptionsOptions.map((option) => {
                                    const isEnabled =
                                        normalizedOptions[option.value]
                                            ?.value || false;
                                    return (
                                        <ToggleGroup.ToggleGroupItem
                                            key={option.value}
                                            asChild
                                            value={option.value}>
                                            <Button
                                                size="lg"
                                                variant="helper"
                                                className="w-full items-start py-5">
                                                <div className="flex w-full flex-row justify-between gap-6">
                                                    <div className="flex min-w-0 flex-col gap-2">
                                                        <div className="flex items-center gap-2">
                                                            <Heading
                                                                variant="h3"
                                                                className="truncate">
                                                                {option.name}
                                                            </Heading>
                                                            <OverrideIndicatorForm
                                                                fieldName={`reviewOptions.${option.value}`}
                                                            />
                                                        </div>

                                                        <p className="text-text-secondary text-xs">
                                                            {option.description}
                                                        </p>
                                                    </div>

                                                    <Checkbox
                                                        decorative
                                                        checked={isEnabled}
                                                    />
                                                </div>
                                            </Button>
                                        </ToggleGroup.ToggleGroupItem>
                                    );
                                })}
                            </ToggleGroup.Root>
                        </FormControl.Input>
                    </FormControl.Root>
                );
            }}
        />
    );
};
