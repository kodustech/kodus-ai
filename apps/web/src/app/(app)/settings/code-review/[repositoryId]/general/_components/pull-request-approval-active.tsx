"use client";

import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";

export const PullRequestApprovalActive = ({
    conditionalApprovalEnabled,
}: {
    conditionalApprovalEnabled: boolean;
}) => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <Controller
            name="pullRequestApprovalActive.value"
            control={form.control}
            render={({ field }) => (
                <div className="border-card-lv3/60 flex flex-wrap items-start justify-between gap-4 border-b px-5 py-5 sm:px-6 sm:py-6">
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2.5">
                            <h2 className="text-text-primary text-lg font-semibold tracking-tight">
                                Automatic PR approval
                            </h2>
                            <span
                                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                                    field.value
                                        ? "bg-primary-light/15 text-primary-light"
                                        : "bg-card-lv3 text-text-secondary"
                                }`}>
                                {field.value ? "On" : "Off"}
                            </span>
                            <OverrideIndicatorForm fieldName="pullRequestApprovalActive" />
                        </div>
                        <p className="text-text-secondary mt-1.5 max-w-2xl text-sm leading-5">
                            {conditionalApprovalEnabled
                                ? "After a clean automated review, Kody approves a PR only when it passes the conditions below."
                                : "After a clean automated review, Kody can approve the PR automatically."}
                        </p>
                    </div>
                    <Switch
                        id={field.name}
                        aria-label="Automatic PR approval"
                        checked={field.value ?? false}
                        disabled={field.disabled}
                        onCheckedChange={field.onChange}
                        className="mt-0.5 shrink-0"
                    />
                </div>
            )}
        />
    );
};
