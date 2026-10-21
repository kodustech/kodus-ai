"use client";

import { FormControl } from "@components/ui/form-control";
import { Switch } from "@components/ui/switch";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import { Controller, useFormContext, useWatch } from "react-hook-form";
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
                                    {help}
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
    const riskAssessmentActive = useWatch({
        control: form.control,
        name: "approvalRiskActive.value",
    });

    return (
        <div>
            <section className="border-card-lv3/60 grid border-b lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="border-card-lv3/60 bg-card-lv2/30 border-b px-5 py-5 sm:px-6 lg:border-r lg:border-b-0">
                    <span className="text-text-tertiary font-mono text-[11px] tracking-widest uppercase">
                        01 / Eligibility
                    </span>
                    <h3 className="text-text-primary mt-2 text-sm font-semibold">
                        Which PRs qualify?
                    </h3>
                    <p className="text-text-secondary mt-1 text-xs leading-5">
                        When both filters are set, a PR must match a label and
                        an author.
                    </p>
                </div>
                <div className="min-w-0 px-5 py-5 sm:px-6 sm:py-6">
                    <EligibilityFields />
                </div>
            </section>

            <section className="grid lg:grid-cols-[220px_minmax(0,1fr)]">
                <div className="border-card-lv3/60 bg-card-lv2/30 border-b px-5 py-5 sm:px-6 lg:border-r lg:border-b-0">
                    <span className="text-text-tertiary font-mono text-[11px] tracking-widest uppercase">
                        02 / Guardrails
                    </span>
                    <h3 className="text-text-primary mt-2 text-sm font-semibold">
                        When does a person decide?
                    </h3>
                    <p className="text-text-secondary mt-1 text-xs leading-5">
                        These checks can hold approval even after a clean
                        review.
                    </p>
                </div>
                <div className="flex min-w-0 flex-col gap-5 px-5 py-5 sm:px-6 sm:py-6">
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
                                            Approve only low-risk PRs. Kody
                                            considers the changes and historical
                                            code-area risk.
                                        </p>
                                    </div>
                                    <Switch
                                        id={field.name}
                                        checked={field.value ?? false}
                                        disabled={field.disabled}
                                        onCheckedChange={field.onChange}
                                        className="shrink-0"
                                    />
                                </div>
                            )}
                        />

                        {riskAssessmentActive && (
                            <Controller
                                name="approvalRiskInstructions.value"
                                control={form.control}
                                render={({ field }) => (
                                    <FormControl.Root className="border-card-lv3/60 mt-4 border-t pt-4">
                                        <div className="mb-2 flex flex-wrap items-center gap-2">
                                            <FormControl.Label
                                                htmlFor={field.name}
                                                className="mb-0 font-medium">
                                                Team risk guidance
                                            </FormControl.Label>
                                            <OverrideIndicatorForm fieldName="approvalRiskInstructions" />
                                        </div>
                                        <FormControl.Input>
                                            <Textarea
                                                id={field.name}
                                                value={field.value ?? ""}
                                                disabled={field.disabled}
                                                maxLength={4000}
                                                onChange={field.onChange}
                                                placeholder="What should require a person to approve?"
                                                className="bg-card-lv1 min-h-24 resize-y px-4 py-3"
                                            />
                                        </FormControl.Input>
                                        <FormControl.Helper className="text-xs leading-5">
                                            Add team-specific context. The clean
                                            review requirement still applies. Up
                                            to 4,000 characters.
                                        </FormControl.Helper>
                                    </FormControl.Root>
                                )}
                            />
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
