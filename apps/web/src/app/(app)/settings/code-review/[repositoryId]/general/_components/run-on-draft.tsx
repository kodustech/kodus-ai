"use client";

import { Controller, useFormContext } from "react-hook-form";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";

import type { CodeReviewFormType } from "../../../_types";
import { SettingToggleRow } from "./setting-toggle-row";

export const RunOnDraft = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();

    return (
        <Controller
            name="runOnDraft.value"
            control={form.control}
            defaultValue={config?.runOnDraft?.value}
            render={({ field }) => (
                <SettingToggleRow
                    id={field.name}
                    title="Review draft pull requests"
                    description="Run automated reviews and give feedback before a draft is ready for review."
                    fieldName="runOnDraft"
                    checked={field.value}
                    disabled={field.disabled}
                    onCheckedChange={field.onChange}
                />
            )}
        />
    );
};
