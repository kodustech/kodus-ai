"use client";

import { Controller, useFormContext } from "react-hook-form";
import { useShouldHideRequestChanges } from "src/app/(app)/settings/_components/use-code-management-platform";

import type { CodeReviewFormType } from "../../../_types";
import { SettingToggleRow } from "./setting-toggle-row";

export const IsRequestChangesActive = () => {
    const form = useFormContext<CodeReviewFormType>();
    const shouldHide = useShouldHideRequestChanges();

    if (shouldHide) return null;

    return (
        <Controller
            name="isRequestChangesActive.value"
            control={form.control}
            render={({ field }) => (
                <SettingToggleRow
                    id={field.name}
                    title="Request changes on critical issues"
                    description="When Kody finds critical issues, set the pull request review to Request Changes."
                    fieldName="isRequestChangesActive"
                    checked={field.value}
                    disabled={field.disabled}
                    onCheckedChange={field.onChange}
                />
            )}
        />
    );
};
