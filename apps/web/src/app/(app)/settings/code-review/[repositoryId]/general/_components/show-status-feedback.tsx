"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";

export const ShowStatusFeedback = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();

    return (
        <Controller
            name="showStatusFeedback.value"
            control={form.control}
            defaultValue={config?.showStatusFeedback?.value}
            render={({ field }) => (
                <Button
                    size="sm"
                    variant="helper"
                    disabled={field.disabled}
                    onClick={() => field.onChange(!field.value)}
                    className="w-full">
                    <CardHeader className="flex flex-row items-center justify-between gap-6">
                        <div className="flex flex-col gap-1">
                            <div className="flex flex-row items-center gap-2">
                                <Heading variant="h3">
                                    Show Status Feedback
                                </Heading>

                                <OverrideIndicatorForm fieldName="showStatusFeedback" />
                            </div>

                            <p className="text-text-secondary text-sm">
                                If enabled, Kody shows status feedback (emoji
                                reaction or comment) when a review is skipped or
                                blocked.
                            </p>
                        </div>

                        <Switch decorative checked={field.value} />
                    </CardHeader>
                </Button>
            )}
        />
    );
};
