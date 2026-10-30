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

/** What teams most often tell a reviewer; one click adds it. */
const GUIDANCE_EXAMPLES = [
    "Ignore criteria about copy and visual design; QA covers those.",
    "Feature flags count as implemented when the flag exists and defaults to off.",
    "Tests are not a requirement unless the task asks for them.",
    "A requirement covered by a linked sub-task is delivered there, not here.",
] as const;

/** Where criteria live and the team's guidance (UC-08, UC-23). */
export const Tune = ({ canEdit }: { canEdit: boolean }) => {
    const form = useFormContext<CodeReviewFormType>();
    const location =
        (useWatch({
            control: form.control,
            name: "businessLogic.criteriaLocation.value" as never,
        }) as string | undefined) ?? "auto";

    return (
        <Collapsible className="bg-card-lv1 rounded-xl" defaultOpen>
            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left">
                    <span className="flex flex-col">
                        <span className="text-text-primary text-sm font-medium">
                            Requirements
                        </span>
                        <span className="text-text-secondary text-xs">
                            Where Kody finds the acceptance criteria, and how
                            your team counts one as done
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
                                        In a custom field · the task field your
                                        team fills
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
                                    <div className="flex flex-col gap-1">
                                        <Input
                                            placeholder="Field name or id, e.g. Acceptance Criteria"
                                            value={
                                                (field.value as string) ?? ""
                                            }
                                            onChange={field.onChange}
                                            disabled={
                                                !canEdit || field.disabled
                                            }
                                        />
                                        <p className="text-text-secondary text-xs">
                                            A task without this field is read
                                            from its description.
                                        </p>
                                    </div>
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
                            render={({ field, fieldState }) => {
                                const text = (field.value as string) ?? "";
                                const add = (line: string) =>
                                    field.onChange(
                                        text.trim()
                                            ? `${text.trimEnd()}\n${line}`
                                            : line,
                                    );
                                return (
                                    <div className="flex flex-col gap-2">
                                        <Textarea
                                            rows={4}
                                            maxLength={MAX_GUIDANCE}
                                            placeholder="How your team counts a requirement as done, in plain words."
                                            value={text}
                                            onChange={field.onChange}
                                            disabled={
                                                !canEdit || field.disabled
                                            }
                                            error={fieldState.error}
                                        />
                                        <div className="flex flex-wrap gap-2">
                                            {GUIDANCE_EXAMPLES.filter(
                                                (example) =>
                                                    !text.includes(example),
                                            ).map((example) => (
                                                <button
                                                    key={example}
                                                    type="button"
                                                    disabled={
                                                        !canEdit ||
                                                        field.disabled
                                                    }
                                                    onClick={() => add(example)}
                                                    className="border-card-lv3 text-text-secondary hover:text-text-primary rounded-full border px-3 py-1 text-xs disabled:opacity-50">
                                                    + {example}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            }}
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
