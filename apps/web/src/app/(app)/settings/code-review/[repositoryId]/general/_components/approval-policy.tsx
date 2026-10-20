"use client";

import { FormControl } from "@components/ui/form-control";
import { Switch } from "@components/ui/switch";
import TagInput from "@components/ui/tag-input";
import { Textarea } from "@components/ui/textarea";
import { Controller, useFormContext } from "react-hook-form";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";

const listFields = [
    {
        name: "approvalLabels" as const,
        label: "Approval labels",
        placeholder: "Add a label",
        help: "Only PRs with one of these labels are eligible. Leave empty for any label.",
    },
    {
        name: "approvalAuthors" as const,
        label: "Approval authors",
        placeholder: "Add a provider login",
        help: "Only PRs by one of these authors are eligible. If labels are also set, both conditions apply.",
    },
    {
        name: "approvalSensitivePaths" as const,
        label: "Sensitive paths",
        placeholder: "Add a file glob",
        help: "Changes to these paths always require a person to approve.",
    },
];

export function ApprovalPolicySettings() {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <div className="flex flex-col gap-6">
            {listFields.map(({ name, label, placeholder, help }) => (
                <Controller
                    key={name}
                    name={`${name}.value`}
                    control={form.control}
                    render={({ field }) => (
                        <FormControl.Root>
                            <div className="mb-2 flex items-center gap-2">
                                <FormControl.Label htmlFor={field.name}>
                                    {label}
                                </FormControl.Label>
                                <OverrideIndicatorForm fieldName={name} />
                            </div>
                            <FormControl.Input>
                                <TagInput
                                    id={field.name}
                                    disabled={field.disabled}
                                    tags={field.value ?? []}
                                    placeholder={placeholder}
                                    onTagsChange={field.onChange}
                                />
                            </FormControl.Input>
                            <FormControl.Helper>{help}</FormControl.Helper>
                        </FormControl.Root>
                    )}
                />
            ))}

            <Controller
                name="approvalRiskActive.value"
                control={form.control}
                render={({ field }) => (
                    <FormControl.Root>
                        <div className="flex items-center gap-2">
                            <FormControl.Label htmlFor={field.name}>
                                Assess PR risk before approval
                            </FormControl.Label>
                            <OverrideIndicatorForm fieldName="approvalRiskActive" />
                            <Switch
                                id={field.name}
                                checked={field.value ?? false}
                                disabled={field.disabled}
                                onCheckedChange={field.onChange}
                            />
                        </div>
                        <FormControl.Helper>
                            Only PRs assessed as low risk can be approved
                            automatically.
                        </FormControl.Helper>
                    </FormControl.Root>
                )}
            />

            <Controller
                name="approvalRiskInstructions.value"
                control={form.control}
                render={({ field }) => (
                    <FormControl.Root>
                        <div className="mb-2 flex items-center gap-2">
                            <FormControl.Label htmlFor={field.name}>
                                Team risk guidance
                            </FormControl.Label>
                            <OverrideIndicatorForm fieldName="approvalRiskInstructions" />
                        </div>
                        <FormControl.Input>
                            <Textarea
                                id={field.name}
                                value={field.value ?? ""}
                                disabled={field.disabled}
                                onChange={field.onChange}
                                placeholder="Describe changes that should require human approval"
                            />
                        </FormControl.Input>
                        <FormControl.Helper>
                            Kody uses this text when assessing risk. It does not
                            bypass the clean review requirement.
                        </FormControl.Helper>
                    </FormControl.Root>
                )}
            />
        </div>
    );
}
