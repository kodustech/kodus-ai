"use client";

import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Controller, useFormContext } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import {
    GroupingModeSuggestions,
    type CodeReviewFormType,
} from "../../../_types";
import { CodeGroupingExampleCard } from "./code-grouping-example-card";

const GroupingModeOptions = [
    {
        value: GroupingModeSuggestions.FULL,
        name: "Unified Comments",
        default: true,
    },
    {
        value: GroupingModeSuggestions.MINIMAL,
        name: "Individual Comments",
    },
] satisfies Array<{ value: string; name: string; default?: boolean }>;

export const SuggestionGroupingMode = () => {
    const form = useFormContext<CodeReviewFormType>();
    const groupingType = form.getValues("suggestionControl.groupingMode");

    return (
        <>
            <div>
                <Heading variant="h2">Suggestion grouping mode</Heading>
                <span className="text-text-secondary text-sm">
                    Define how Kody consolidates multiple suggestions in a
                    single PR.
                </span>
            </div>

            <div className="mt-3 flex flex-row gap-6">
                <Controller
                    name="suggestionControl.groupingMode.value"
                    control={form.control}
                    render={({ field }) => (
                        <FormControl.Root className="flex-1">
                            <FormControl.Label htmlFor={field.name}>
                                Choose mode
                            </FormControl.Label>

                            <FormControl.Input>
                                <ToggleGroup.Root
                                    id={field.name}
                                    type="single"
                                    disabled={field.disabled}
                                    className="flex flex-1 flex-col gap-2"
                                    value={field.value}
                                    onValueChange={(value) => {
                                        if (value) field.onChange(value);
                                    }}>
                                    {GroupingModeOptions.map((option) => (
                                        <ToggleGroup.ToggleGroupItem
                                            asChild
                                            key={option.value}
                                            value={option.value}>
                                            <Button
                                                size="md"
                                                variant="helper"
                                                className="h-auto w-full justify-between py-4">
                                                <div className="flex flex-col gap-2">
                                                    <div className="flex items-center gap-1">
                                                        <Heading variant="h3">
                                                            {option.name}
                                                        </Heading>
                                                        {option.default && (
                                                            <small className="text-text-secondary">
                                                                (default)
                                                            </small>
                                                        )}
                                                    </div>
                                                </div>

                                                <Checkbox
                                                    decorative
                                                    checked={
                                                        field.value ===
                                                        option.value
                                                    }
                                                />
                                            </Button>
                                        </ToggleGroup.ToggleGroupItem>
                                    ))}

                                    <OverrideIndicatorForm
                                        fieldName="suggestionControl.groupingMode"
                                        className="mb-2"
                                    />
                                </ToggleGroup.Root>
                            </FormControl.Input>
                        </FormControl.Root>
                    )}
                />

                <div className="flex-2">
                    <CodeGroupingExampleCard
                        groupingType={groupingType?.value!}
                    />
                </div>
            </div>
        </>
    );
};
