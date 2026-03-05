"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";

import type { CodeReviewFormType } from "../../../_types";

export const FineTuningToggle = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();

    return (
        <Controller
            name="kodyFineTuningEnabled.value"
            control={form.control}
            defaultValue={!!config?.kodyFineTuningEnabled?.value}
            render={({ field }) => {
                return (
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
                                        Fine-Tuning Enabled
                                    </Heading>

                                    <OverrideIndicatorForm fieldName="kodyFineTuningEnabled" />
                                </div>

                                <p className="text-text-secondary text-sm">
                                    When enabled, Kody learns from feedback on suggestions to improve
                                    future reviews. Disable to exclude this repository from fine-tuning.
                                </p>
                            </div>

                            <Switch decorative checked={field.value} />
                        </CardHeader>
                    </Button>
                );
            }}
        />
    );
};
