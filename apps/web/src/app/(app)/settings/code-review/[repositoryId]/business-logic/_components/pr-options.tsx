"use client";

import { Heading } from "@components/ui/heading";
import { Label } from "@components/ui/label";
import { Link } from "@components/ui/link";
import { RadioGroup } from "@components/ui/radio-group";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { addSearchParamsToUrl } from "src/core/utils/url";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";
import { useCodeReviewRouteParams } from "../../../../_hooks";

const SWITCHES = [
    {
        name: "commentWhenMet",
        label: "Comment when every requirement is met",
        hint: "Posts a short note when every requirement is met. Off, a passing PR gets no comment.",
    },
    {
        name: "requireTask",
        label: "Ask for a task when the PR references none",
        hint: "Kody asks which task the PR is for. Bot PRs (Dependabot, Renovate) are left alone. Off, a PR without a task is skipped quietly.",
    },
] as const;

const RECHECK = [
    {
        value: "request",
        label: "Only on request",
        hint: "Kody checks on the first review. After that, anyone re-checks with @kody -v business-logic.",
    },
    {
        value: "failing",
        label: "While something is missing",
        hint: "Each push re-checks until every requirement is met or a task is named, then stops.",
    },
    {
        value: "push",
        label: "On every push",
        hint: "Every push re-checks, even a PR that already passes.",
    },
] as const;

/** What Kody does on the pull request (UC-26, UC-35). */
export const PrOptions = ({ canEdit }: { canEdit: boolean }) => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const form = useFormContext<CodeReviewFormType>();
    return (
        <section className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">On the pull request</Heading>
                {/* The review stops before Business Logic on these PRs: the
                    same settings decide both, set once in General. */}
                <p className="text-text-secondary text-sm">
                    Skips the PRs code review skips (WIP titles, and drafts when
                    reviews don&apos;t run on them). Set those in{" "}
                    <Link
                        href={addSearchParamsToUrl(
                            `/settings/code-review/${repositoryId}/general`,
                            { directoryId },
                        )}>
                        General
                    </Link>
                    .
                </p>
            </div>
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
                                value={(field.value as string) ?? "request"}
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
