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
        hint: "Off: only the kody/business-logic check turns green.",
        hintWithoutChecks:
            "Off: when every requirement is met, Kody posts nothing; there is no check to turn green here.",
    },
    {
        name: "requireTask",
        label: "Require a task",
        hint: "On: a PR that references no existing task fails the check, and Kody asks for one. Off: it's skipped.",
        hintWithoutChecks:
            "On: a PR that references no existing task gets a comment asking for one. Off: it's skipped.",
    },
] as const;

const RECHECK = [
    {
        value: "failing",
        label: "While the check fails",
        labelWithoutChecks: "While something blocks the merge",
        hint: "A push re-checks until the PR passes, so a fix turns it green without anyone asking.",
        hintWithoutChecks:
            "A push re-checks until nothing blocks the merge, so a fix updates the comment without anyone asking.",
    },
    {
        value: "push",
        label: "On every push",
        hint: "Also re-checks a PR that already passes. Costs one check per push.",
    },
    {
        value: "request",
        label: "Only on request",
        hint: "Kody checks the first review; anyone re-checks with @kody -v business-logic.",
    },
] as const;

/** What Kody does on the pull request (UC-26, UC-35). */
export const PrOptions = ({
    canEdit,
    platformHasChecks,
}: {
    canEdit: boolean;
    platformHasChecks: boolean;
}) => {
    const form = useFormContext<CodeReviewFormType>();
    const hint = (option: { hint: string; hintWithoutChecks?: string }) =>
        !platformHasChecks && option.hintWithoutChecks
            ? option.hintWithoutChecks
            : option.hint;
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
                                        {hint(option)}
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
                                                {!platformHasChecks &&
                                                "labelWithoutChecks" in option
                                                    ? option.labelWithoutChecks
                                                    : option.label}
                                            </span>
                                            <span className="text-text-secondary text-xs font-normal">
                                                {hint(option)}
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
