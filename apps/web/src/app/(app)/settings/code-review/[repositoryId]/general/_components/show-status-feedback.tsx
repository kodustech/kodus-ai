"use client";

import { Controller, useFormContext } from "react-hook-form";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";

import type { CodeReviewFormType } from "../../../_types";
import { SettingToggleRow } from "./setting-toggle-row";

export const ShowStatusFeedback = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();

    return (
        <Controller
            name="showStatusFeedback.value"
            control={form.control}
            defaultValue={config?.showStatusFeedback?.value}
            render={({ field }) => (
                <SettingToggleRow
                    id={field.name}
                    title="Show status feedback"
                    description="React or comment when a review is skipped or blocked."
                    fieldName="showStatusFeedback"
                    checked={field.value}
                    disabled={field.disabled}
                    onCheckedChange={field.onChange}
                />
            )}
        />
    );
};
