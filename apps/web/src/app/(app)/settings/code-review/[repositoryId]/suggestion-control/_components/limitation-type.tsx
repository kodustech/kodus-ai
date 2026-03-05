import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { ToggleGroup } from "@components/ui/toggle-group";
import { Controller, useFormContext } from "react-hook-form";
import { cn } from "src/core/utils/components";

import { OverrideIndicatorForm } from "../../../_components/override";
import { LimitationType, type CodeReviewFormType } from "../../../_types";

const limitationTypeOptions = [
    {
        value: LimitationType.FILE,
        name: "By file",
    },
    {
        default: true,
        value: LimitationType.PR,
        name: "By pull request",
    },
    {
        value: LimitationType.SEVERITY,
        name: "By severity",
    },
] satisfies Array<{ value: string; name: string; default?: boolean }>;

export const LimitationTypeField = () => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <Controller
            name="suggestionControl.limitationType.value"
            control={form.control}
            render={({ field }) => (
                <FormControl.Root className="space-y-1">
                    <div className="mb-2 flex flex-row items-center gap-2">
                        <FormControl.Label htmlFor={field.name}>
                            Limitation type
                        </FormControl.Label>

                        <OverrideIndicatorForm fieldName="suggestionControl.limitationType" />
                    </div>

                    <FormControl.Input>
                        <ToggleGroup.Root
                            id={field.name}
                            type="single"
                            disabled={field.disabled}
                            className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3"
                            value={field.value}
                            onValueChange={(value) => {
                                if (value) field.onChange(value);
                                form.trigger(
                                    "suggestionControl.maxSuggestions",
                                );
                            }}>
                            {limitationTypeOptions.map((option) => (
                                <ToggleGroup.ToggleGroupItem
                                    asChild
                                    key={option.value}
                                    value={option.value}>
                                    <Button
                                        size="md"
                                        variant="helper"
                                        className={cn(
                                            "w-full justify-between py-4",
                                        )}>
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
                                                field.value === option.value
                                            }
                                        />
                                    </Button>
                                </ToggleGroup.ToggleGroupItem>
                            ))}
                        </ToggleGroup.Root>
                    </FormControl.Input>
                </FormControl.Root>
            )}
        />
    );
};
