"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";
import { useShouldHideRequestChanges } from "src/app/(app)/settings/_components/use-code-management-platform";

import type { CodeReviewFormType } from "../../../_types";

export const IsRequestChangesActive = () => {
    const form = useFormContext<CodeReviewFormType>();
    const shouldHide = useShouldHideRequestChanges();

    if (shouldHide) return null;

    return (
        <div className="flex flex-col gap-2">
            <Controller
                name="isRequestChangesActive.value"
                control={form.control}
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
                                        Enable changing status of Review to
                                        'Request Changes'
                                    </Heading>

                                    <OverrideIndicatorForm fieldName="isRequestChangesActive" />
                                </div>

                                <p className="text-text-secondary text-sm">
                                    When Kody completes an automated code review
                                    and finds critical issues, it will
                                    automatically change the status of it's Pull
                                    Request Review to 'Request Changes'.
                                </p>
                            </div>

                            <Switch decorative checked={field.value} />
                        </CardHeader>
                    </Button>
                )}
            />
        </div>
    );
};
