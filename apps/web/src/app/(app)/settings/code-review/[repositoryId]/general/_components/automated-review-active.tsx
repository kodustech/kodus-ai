"use client";

import { Collapsible, CollapsibleContent } from "@components/ui/collapsible";
import { FormControl } from "@components/ui/form-control";
import { InlineCode } from "@components/ui/inline-code";
import { NumberInput } from "@components/ui/number-input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Separator } from "@components/ui/separator";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import { ReviewCadenceType, type CodeReviewFormType } from "../../../_types";

export const AutomatedReviewActive = () => {
    const form = useFormContext<CodeReviewFormType>();
    const reviewCadenceType = form.watch("reviewCadence.type.value");

    return (
        <Controller
            name="automatedReviewActive.value"
            control={form.control}
            render={({ field }) => (
                <div>
                    <Collapsible open={field.value}>
                        <div className="flex min-w-0 items-start justify-between gap-4 px-5 py-5 sm:px-6">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <label
                                        htmlFor={field.name}
                                        className="text-text-primary cursor-pointer text-base leading-5 font-semibold">
                                        Automated code review
                                    </label>
                                    <OverrideIndicatorForm fieldName="automatedReviewActive" />
                                </div>
                                <p className="text-text-secondary mt-1.5 text-sm leading-5">
                                    Review pull requests automatically and
                                    highlight issues and improvements.
                                </p>
                                <p className="text-text-tertiary mt-1 text-xs leading-5">
                                    When off, start a review by commenting{" "}
                                    <InlineCode>@kody start-review</InlineCode>{" "}
                                    on the pull request.
                                </p>
                            </div>
                            <Switch
                                id={field.name}
                                checked={field.value ?? false}
                                disabled={field.disabled}
                                onCheckedChange={(newValue) => {
                                    field.onChange(newValue);

                                    if (newValue) {
                                        const currentCadence = form.getValues(
                                            "reviewCadence.type.value",
                                        );

                                        if (!currentCadence) {
                                            form.setValue(
                                                "reviewCadence.type.value",
                                                ReviewCadenceType.AUTOMATIC,
                                                { shouldDirty: true },
                                            );
                                        }

                                        form.trigger();
                                    } else {
                                        form.resetField("reviewCadence");

                                        form.trigger();
                                    }
                                }}
                                className="mt-0.5 shrink-0"
                            />
                        </div>
                        <CollapsibleContent>
                            <div className="border-card-lv3/60 min-w-0 border-t px-5 py-5 sm:px-6">
                                <Controller
                                    name="reviewCadence.type.value"
                                    control={form.control}
                                    render={({ field }) => (
                                        <FormControl.Root>
                                            <div className="mb-2 flex flex-row items-center gap-2">
                                                <FormControl.Label
                                                    htmlFor={field.name}
                                                    className="mb-0">
                                                    Review Cadence
                                                </FormControl.Label>

                                                <OverrideIndicatorForm fieldName="reviewCadence.type" />
                                            </div>
                                            <FormControl.Helper className="text-text-secondary mt-0 mb-2 text-xs">
                                                Decide how Kody should run
                                                follow-up reviews after the
                                                first one.
                                            </FormControl.Helper>

                                            <FormControl.Input>
                                                <Select
                                                    value={field.value}
                                                    disabled={field.disabled}
                                                    onValueChange={
                                                        field.onChange
                                                    }>
                                                    <SelectTrigger
                                                        size="md"
                                                        id={field.name}>
                                                        <SelectValue placeholder="Select review cadence" />
                                                    </SelectTrigger>

                                                    <SelectContent>
                                                        <SelectItem
                                                            className="min-h-auto py-2 pl-4 text-sm"
                                                            value={
                                                                ReviewCadenceType.AUTOMATIC
                                                            }>
                                                            Automatic
                                                        </SelectItem>

                                                        <SelectItem
                                                            className="min-h-auto py-2 pl-4 text-sm"
                                                            value={
                                                                ReviewCadenceType.AUTO_PAUSE
                                                            }>
                                                            Auto-pause
                                                        </SelectItem>

                                                        <SelectItem
                                                            className="min-h-auto py-2 pl-4 text-sm"
                                                            value={
                                                                ReviewCadenceType.MANUAL
                                                            }>
                                                            Manual
                                                        </SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </FormControl.Input>

                                            <FormControl.Helper className="text-text-secondary text-xs">
                                                {field.value ===
                                                    ReviewCadenceType.AUTOMATIC &&
                                                    "Review every new push"}

                                                {field.value ===
                                                    ReviewCadenceType.AUTO_PAUSE &&
                                                    "Pause if a push burst is detected"}

                                                {field.value ===
                                                    ReviewCadenceType.MANUAL && (
                                                    <>
                                                        Only run when you
                                                        comment{" "}
                                                        <InlineCode>
                                                            @kody start-review
                                                        </InlineCode>
                                                    </>
                                                )}
                                            </FormControl.Helper>
                                        </FormControl.Root>
                                    )}
                                />

                                {reviewCadenceType ===
                                    ReviewCadenceType.AUTO_PAUSE && (
                                    <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:gap-8">
                                        <Controller
                                            name="reviewCadence.pushesToTrigger.value"
                                            control={form.control}
                                            render={({ field, fieldState }) => (
                                                <FormControl.Root>
                                                    <div className="flex flex-row items-center gap-2">
                                                        <FormControl.Label
                                                            htmlFor={
                                                                field.name
                                                            }>
                                                            Pushes to trigger
                                                            pause
                                                        </FormControl.Label>

                                                        <OverrideIndicatorForm fieldName="reviewCadence.pushesToTrigger" />
                                                    </div>

                                                    <FormControl.Input>
                                                        <NumberInput.Root
                                                            min={1}
                                                            size="md"
                                                            className="w-52"
                                                            value={
                                                                field.value || 3
                                                            }
                                                            disabled={
                                                                field.disabled
                                                            }
                                                            onValueChange={
                                                                field.onChange
                                                            }>
                                                            <NumberInput.Decrement />
                                                            <NumberInput.Input
                                                                id={field.name}
                                                                error={
                                                                    fieldState.error
                                                                }
                                                            />
                                                            <NumberInput.Increment />
                                                        </NumberInput.Root>
                                                    </FormControl.Input>
                                                </FormControl.Root>
                                            )}
                                        />

                                        <Separator
                                            orientation="vertical"
                                            className="hidden sm:block"
                                        />

                                        <Controller
                                            name="reviewCadence.timeWindow.value"
                                            control={form.control}
                                            render={({ field, fieldState }) => (
                                                <FormControl.Root>
                                                    <div className="flex flex-row items-center gap-2">
                                                        <FormControl.Label
                                                            htmlFor={
                                                                field.name
                                                            }>
                                                            Time window
                                                            (minutes)
                                                        </FormControl.Label>

                                                        <OverrideIndicatorForm fieldName="reviewCadence.timeWindow" />
                                                    </div>

                                                    <FormControl.Input>
                                                        <NumberInput.Root
                                                            min={1}
                                                            size="md"
                                                            className="w-52"
                                                            value={
                                                                field.value ||
                                                                15
                                                            }
                                                            disabled={
                                                                field.disabled
                                                            }
                                                            onValueChange={
                                                                field.onChange
                                                            }>
                                                            <NumberInput.Decrement />
                                                            <NumberInput.Input
                                                                id={field.name}
                                                                error={
                                                                    fieldState.error
                                                                }
                                                            />
                                                            <NumberInput.Increment />
                                                        </NumberInput.Root>
                                                    </FormControl.Input>
                                                </FormControl.Root>
                                            )}
                                        />
                                    </div>
                                )}
                            </div>
                        </CollapsibleContent>
                    </Collapsible>
                </div>
            )}
        />
    );
};
