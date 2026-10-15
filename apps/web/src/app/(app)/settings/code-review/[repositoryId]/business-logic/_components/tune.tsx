"use client";

import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { Textarea } from "@components/ui/textarea";
import { Controller, useFormContext, useWatch } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

const MAX_GUIDANCE = 2000;

/** Where criteria live and the team's guidance (UC-08, UC-23). */
export const Tune = ({ canEdit }: { canEdit: boolean }) => {
    const form = useFormContext<CodeReviewFormType>();
    const location =
        (useWatch({
            control: form.control,
            name: "businessLogic.criteriaLocation.value" as never,
        }) as string | undefined) ?? "auto";

    return (
        <Collapsible className="bg-card-lv1 rounded-xl">
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
                    <span className="flex flex-col">
                        <span className="text-text-primary text-sm font-medium">
                            Tune to your team
                        </span>
                        <span className="text-text-secondary text-xs">
                            Where criteria live · team guidance
                        </span>
                    </span>
                    <CollapsibleIndicator />
                </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="border-card-lv3/60 flex flex-col gap-6 border-t px-5 py-5">
                    <div className="flex flex-col gap-3">
                        <span className="flex items-center gap-2">
                            <span className="text-text-primary text-sm font-medium">
                                Where acceptance criteria live
                            </span>
                            <OverrideIndicatorForm fieldName="businessLogic.criteriaLocation" />
                        </span>
                        <Controller
                            name={
                                "businessLogic.criteriaLocation.value" as never
                            }
                            control={form.control}
                            render={({ field }) => (
                                <RadioGroup.Root
                                    value={(field.value as string) ?? "auto"}
                                    onValueChange={field.onChange}
                                    disabled={!canEdit || field.disabled}
                                    className="gap-2">
                                    <Label className="flex cursor-pointer items-center gap-3 text-sm">
                                        <RadioGroup.Item value="auto" />
                                        Detect automatically · criteria field,
                                        checklist, or list in the description
                                    </Label>
                                    <Label className="flex cursor-pointer items-center gap-3 text-sm">
                                        <RadioGroup.Item value="heading" />
                                        Under a heading in the description
                                    </Label>
                                    <Label className="flex cursor-pointer items-center gap-3 text-sm">
                                        <RadioGroup.Item value="field" />
                                        In a custom field · Jira or Azure
                                        Boards, the field your team fills
                                    </Label>
                                </RadioGroup.Root>
                            )}
                        />
                        {location === "heading" && (
                            <Controller
                                name={
                                    "businessLogic.criteriaHeading.value" as never
                                }
                                control={form.control}
                                render={({ field }) => (
                                    <Input
                                        placeholder="e.g. Acceptance criteria"
                                        value={(field.value as string) ?? ""}
                                        onChange={field.onChange}
                                        disabled={!canEdit || field.disabled}
                                    />
                                )}
                            />
                        )}
                        {location === "field" && (
                            <Controller
                                name={
                                    "businessLogic.criteriaField.value" as never
                                }
                                control={form.control}
                                render={({ field }) => (
                                    <Input
                                        placeholder="Field name or id, e.g. Acceptance Criteria or customfield_10031"
                                        value={(field.value as string) ?? ""}
                                        onChange={field.onChange}
                                        disabled={!canEdit || field.disabled}
                                    />
                                )}
                            />
                        )}
                    </div>

                    <div className="flex flex-col gap-3">
                        <span className="flex items-center gap-2">
                            <span className="text-text-primary text-sm font-medium">
                                Team guidance
                            </span>
                            <OverrideIndicatorForm fieldName="businessLogic.teamGuidance" />
                        </span>
                        <Controller
                            name={"businessLogic.teamGuidance.value" as never}
                            control={form.control}
                            rules={{ maxLength: MAX_GUIDANCE }}
                            render={({ field, fieldState }) => (
                                <Textarea
                                    rows={4}
                                    maxLength={MAX_GUIDANCE}
                                    placeholder={
                                        "Ignore criteria about copy and visual design; QA covers those.\nFeature flags count as implemented when the flag exists and defaults to off."
                                    }
                                    value={(field.value as string) ?? ""}
                                    onChange={field.onChange}
                                    disabled={!canEdit || field.disabled}
                                    error={fieldState.error}
                                />
                            )}
                        />
                        <p className="text-text-secondary text-xs">
                            Added to what Kody follows. It can&apos;t change the
                            verdict format or make Kody invent requirements.
                        </p>
                    </div>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};
