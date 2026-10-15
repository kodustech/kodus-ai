"use client";

import { Heading } from "@components/ui/heading";
import { Label } from "@components/ui/label";
import { RadioGroup } from "@components/ui/radio-group";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

const SWITCHES = [
    {
        name: "commentWhenMet",
        label: "Comment when every requirement is met",
        hint: "Off: a PR that meets its task gets no comment, so the author can't tell Kody checked it.",
    },
    {
        name: "requireTask",
        label: "Require a task",
        hint: "On: a PR that references no existing task gets a comment asking for one. Off: it's skipped.",
    },
] as const;

const RECHECK = [
    {
        value: "failing",
        label: "While something is left to merge",
        hint: "A push re-checks until the comment lists nothing to merge, so a fix updates it without anyone asking.",
    },
    {
        value: "push",
        label: "On every push",
        hint: "Also re-checks a PR that already passes. One validation per push.",
    },
    {
        value: "request",
        label: "Only on request",
        hint: "Kody checks the first review; anyone re-checks with @kody -v business-logic.",
    },
] as const;

/** What Kody does on the pull request (UC-26, UC-35). */
export const PrOptions = ({ canEdit }: { canEdit: boolean }) => {
    const form = useFormContext<CodeReviewFormType>();
    return (
        <section className="flex flex-col gap-3">
            <Heading variant="h3">On the pull request</Heading>
            <div className="bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y rounded-xl">
                {SWITCHES.map((option) => (
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
                                        {option.hint}
                                    </span>
                                </div>
                            </div>
                        )}
                    />
                ))}

                <div className="flex flex-col gap-3 px-4 py-3">
                    <span className="flex items-center gap-2">
                        <span className="text-text-primary text-sm font-medium">
                            Re-check after a push
                        </span>
                        <OverrideIndicatorForm fieldName="businessLogic.recheckOn" />
                    </span>
                    <Controller
                        name={"businessLogic.recheckOn.value" as never}
                        control={form.control}
                        render={({ field }) => (
                            <RadioGroup.Root
                                value={(field.value as string) ?? "failing"}
                                onValueChange={field.onChange}
                                disabled={!canEdit || field.disabled}
                                className="gap-2">
                                {RECHECK.map((option) => (
                                    <Label
                                        key={option.value}
                                        className="flex cursor-pointer items-start gap-3 text-sm">
                                        <RadioGroup.Item
                                            value={option.value}
                                            className="mt-0.5"
                                        />
                                        <span className="flex flex-col gap-0.5">
                                            <span className="text-text-primary">
                                                {option.label}
                                            </span>
                                            <span className="text-text-secondary text-xs font-normal">
                                                {option.hint}
                                            </span>
                                        </span>
                                    </Label>
                                ))}
                            </RadioGroup.Root>
                        )}
                    />
                </div>
            </div>
        </section>
    );
};
