"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { InlineCode } from "@components/ui/inline-code";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";
import { useCodeReviewConfig } from "src/app/(app)/settings/_components/context";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";

/**
 * Whether reviews read the repository's coding-agent instructions and check
 * the changed lines against them. Its findings go through the severity
 * threshold below like any other.
 */
export const CodingAgentInstructions = () => {
    const form = useFormContext<CodeReviewFormType>();
    const config = useCodeReviewConfig();

    return (
        <Controller
            name="repoInstructionsEnabled.value"
            control={form.control}
            defaultValue={config?.repoInstructionsEnabled?.value}
            render={({ field }) => (
                <Button
                    size="sm"
                    variant="helper"
                    disabled={field.disabled}
                    onClick={() => field.onChange(!field.value)}
                    className="w-full"
                    data-field-name="repoInstructionsEnabled">
                    <CardHeader className="flex flex-row items-center justify-between gap-6">
                        <div className="flex flex-col gap-1">
                            <div className="flex flex-row items-center gap-2">
                                <Heading variant="h3">
                                    Coding-agent instructions
                                </Heading>

                                <OverrideIndicatorForm fieldName="repoInstructionsEnabled" />
                            </div>

                            <p className="text-text-secondary text-sm">
                                Kody reads the files your team writes for coding
                                agents{" "}
                                <InlineCode className="bg-card-lv1">
                                    (CLAUDE.md, AGENTS.md, .cursor/rules,
                                    Copilot instructions)
                                </InlineCode>{" "}
                                that cover the changed files, from the pull
                                request&apos;s target branch, and points out
                                changes that break them. Those comments follow
                                the severity threshold below like any other.
                            </p>
                        </div>

                        <Switch decorative checked={field.value === true} />
                    </CardHeader>
                </Button>
            )}
        />
    );
};
