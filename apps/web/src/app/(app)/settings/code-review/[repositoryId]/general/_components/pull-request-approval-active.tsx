"use client";

import { Badge } from "@components/ui/badge";
import { Controller, useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";
import { SettingToggleRow } from "./setting-toggle-row";

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
                <div className="border-card-lv3/60 border-b">
                    <SettingToggleRow
                        id={field.name}
                        title="Automatic PR approval"
                        fieldName="pullRequestApprovalActive"
                        badge={
                            conditionalApprovalEnabled ? (
                                <Badge>Beta</Badge>
                            ) : (
                                <Badge
                                    variant={
                                        field.value ? "primary-dark" : "helper"
                                    }>
                                    {field.value ? "On" : "Off"}
                                </Badge>
                            )
                        }
                        description={
                            !field.value
                                ? "No PRs will be approved automatically."
                                : conditionalApprovalEnabled
                                  ? "Approve clean PRs that match a policy."
                                  : "Approve PRs after a clean review."
                        }
                        checked={field.value ?? false}
                        disabled={field.disabled}
                        onCheckedChange={field.onChange}
                    />
                </div>
            )}
        />
    );
};
