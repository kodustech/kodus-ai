"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Switch } from "@components/ui/switch";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useApprovalLabelsUnavailable } from "src/app/(app)/settings/_components/use-code-management-platform";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";

const eligibilityFields = [
    {
        name: "approvalLabels" as const,
        label: "PR labels",
        maxTags: 50,
        placeholder: "Add a label",
        help: "Match any listed label. Leave empty to allow all labels.",
    },
    {
        name: "approvalAuthors" as const,
        label: "PR authors",
        maxTags: 50,
        placeholder: "Add a provider login",
        help: "Match a provider username. Leave empty to allow all authors.",
    },
];

function EligibilityFields() {
    const form = useFormContext<CodeReviewFormType>();
    const labelsUnavailable = useApprovalLabelsUnavailable();

    return (
        <div className="grid min-w-0 gap-5 sm:grid-cols-2">
            {eligibilityFields.map(
                ({ name, label, maxTags, placeholder, help }) => (
                    <Controller
                        key={name}
                        name={`${name}.value`}
                        control={form.control}
                        render={({ field }) => (
                            <FormControl.Root className="min-w-0">
                                <div className="mb-2 flex flex-wrap items-center gap-2">
                                    <FormControl.Label
                                        htmlFor={field.name}
                                        className="mb-0 font-medium">
                                        {label}
                                    </FormControl.Label>
                                    <OverrideIndicatorForm fieldName={name} />
                                </div>
                                <FormControl.Input>
                                    <TagInput
                                        id={field.name}
                                        disabled={field.disabled}
                                        tags={field.value ?? []}
                                        maxTags={maxTags}
                                        placeholder={placeholder}
                                        onTagsChange={field.onChange}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper className="text-xs leading-5">
                                    {name === "approvalLabels" &&
                                    labelsUnavailable
                                        ? "Bitbucket ignores approval labels. Azure Repos needs a person while labels are configured. You can remove saved labels here."
                                        : help}
                                </FormControl.Helper>
                            </FormControl.Root>
                        )}
                    />
                ),
            )}
        </div>
    );
}

export function ApprovalPolicySettings() {
    const form = useFormContext<CodeReviewFormType>();
    const [guidanceOpen, setGuidanceOpen] = useState(false);
    const riskAssessmentActive = useWatch({
        control: form.control,
        name: "approvalRiskActive.value",
    });

    return (
        <div>
            <div className="border-card-lv3/60 border-b px-5 py-4 sm:px-6">
                <div className="flex items-center gap-2">
                    <h3 className="text-text-primary text-sm font-semibold">
                        Conditional approval
                    </h3>
                    <Badge>Beta</Badge>
                </div>
            </div>
            <section className="border-card-lv3/60 border-b px-5 py-6 sm:px-6">
                <div className="mb-5">
                    <h3 className="text-text-primary text-base font-semibold">
                        Which PRs can be auto-approved?
                    </h3>
                    <p className="text-text-secondary mt-1 text-sm leading-6">
                        After a clean review, all PRs are eligible by default.
                        Add labels or authors to limit this. If you set both, a
                        PR must match both.
                    </p>
                </div>
                <EligibilityFields />
            </section>

            <section className="px-5 py-6 sm:px-6">
                <div className="mb-5">
                    <h3 className="text-text-primary text-base font-semibold">
                        When is human approval required?
                    </h3>
                    <p className="text-text-secondary mt-1 text-sm leading-6">
                        Files matching a path below always need a person. Turn
                        on risk assessment to also hold PRs Kody cannot judge
                        low risk.
                    </p>
                </div>
                <div className="flex min-w-0 flex-col gap-5">
                    <Controller
                        name="approvalSensitivePaths.value"
                        control={form.control}
                        render={({ field }) => (
                            <FormControl.Root>
                                <div className="mb-2 flex flex-wrap items-center gap-2">
                                    <FormControl.Label
                                        htmlFor={field.name}
                                        className="mb-0 font-medium">
                                        Paths requiring human approval
                                    </FormControl.Label>
                                    <OverrideIndicatorForm fieldName="approvalSensitivePaths" />
                                </div>
                                <FormControl.Input>
                                    <TagInput
                                        id={field.name}
                                        disabled={field.disabled}
                                        tags={field.value ?? []}
                                        maxTags={100}
                                        placeholder="Add a file glob, e.g. src/auth/**"
                                        onTagsChange={field.onChange}
                                    />
                                </FormControl.Input>
                                <FormControl.Helper className="text-xs leading-5">
                                    Any matching file blocks automatic approval.
                                    Up to 100 paths.
                                </FormControl.Helper>
                            </FormControl.Root>
                        )}
                    />

                    <div className="border-card-lv3/60 bg-card-lv2/35 rounded-lg border p-4">
                        <Controller
                            name="approvalRiskActive.value"
                            control={form.control}
                            render={({ field }) => (
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <label
                                                htmlFor={field.name}
                                                className="text-text-primary cursor-pointer text-sm font-medium">
                                                Assess PR risk
                                            </label>
                                            <OverrideIndicatorForm fieldName="approvalRiskActive" />
                                        </div>
                                        <p className="text-text-secondary mt-1 text-xs leading-5">
                                            Kody assesses the PR changes and
                                            available code history using its
                                            built-in criteria. After a clean
                                            review, it approves low-risk PRs and
                                            leaves the others for a person.
                                        </p>
                                    </div>
                                    <Switch
                                        id={field.name}
                                        checked={field.value ?? false}
                                        disabled={field.disabled}
                                        onCheckedChange={(checked) => {
                                            if (!checked)
                                                setGuidanceOpen(false);
                                            field.onChange(checked);
                                        }}
                                        className="shrink-0"
                                    />
                                </div>
                            )}
                        />

                        {riskAssessmentActive && (
                            <div className="border-card-lv3/60 mt-4 border-t pt-4">
                                <Controller
                                    name="approvalRiskInstructions.value"
                                    control={form.control}
                                    render={({ field }) => {
                                        const hasGuidance = Boolean(
                                            field.value?.trim(),
                                        );

                                        return (
                                            <div>
                                                <div className="flex items-start justify-between gap-4">
                                                    <div className="min-w-0">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="text-text-primary text-sm font-medium">
                                                                Additional team
                                                                guidance
                                                            </span>
                                                            <OverrideIndicatorForm fieldName="approvalRiskInstructions" />
                                                        </div>
                                                        {hasGuidance ? (
                                                            <p className="text-text-secondary mt-1 line-clamp-2 text-xs leading-5 break-words whitespace-pre-line">
                                                                {field.value}
                                                            </p>
                                                        ) : (
                                                            <p className="text-text-secondary mt-1 text-xs leading-5">
                                                                No team-specific
                                                                instructions.
                                                            </p>
                                                        )}
                                                    </div>
                                                    <Button
                                                        type="button"
                                                        variant="helper"
                                                        size="xs"
                                                        disabled={
                                                            field.disabled
                                                        }
                                                        aria-expanded={
                                                            guidanceOpen
                                                        }
                                                        onClick={() =>
                                                            setGuidanceOpen(
                                                                !guidanceOpen,
                                                            )
                                                        }>
                                                        {guidanceOpen
                                                            ? "Close"
                                                            : hasGuidance
                                                              ? "Edit"
                                                              : "Add"}
                                                    </Button>
                                                </div>
                                                {guidanceOpen && (
                                                    <FormControl.Root className="mt-4">
                                                        <FormControl.Label
                                                            htmlFor={field.name}
                                                            className="mb-2 font-medium">
                                                            Additional
                                                            instructions
                                                        </FormControl.Label>
                                                        <FormControl.Input>
                                                            <Textarea
                                                                id={field.name}
                                                                value={
                                                                    field.value ??
                                                                    ""
                                                                }
                                                                disabled={
                                                                    field.disabled
                                                                }
                                                                maxLength={4000}
                                                                onChange={
                                                                    field.onChange
                                                                }
                                                                placeholder="e.g. Require a person to approve payment retry changes"
                                                                className="bg-card-lv1 min-h-24 resize-y px-4 py-3"
                                                            />
                                                        </FormControl.Input>
                                                        <FormControl.Helper className="text-xs leading-5">
                                                            These instructions
                                                            add context to
                                                            Kody&apos;s built-in
                                                            assessment. Up to
                                                            4,000 characters.
                                                        </FormControl.Helper>
                                                    </FormControl.Root>
                                                )}
                                            </div>
                                        );
                                    }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
