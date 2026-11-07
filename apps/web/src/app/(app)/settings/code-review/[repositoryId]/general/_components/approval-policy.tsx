"use client";

import { useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Switch } from "@components/ui/switch";
import type { ApprovalPolicy } from "@services/approval-policies/types";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { useController, useFormContext, useWatch } from "react-hook-form";
import {
    useApprovalLabelsUnavailable,
    useApprovalTeamsUnavailable,
} from "src/app/(app)/settings/_components/use-code-management-platform";
import { OverrideIndicatorForm } from "src/app/(app)/settings/code-review/_components/override";

import type { CodeReviewFormType } from "../../../_types";
import { ApprovalPolicyEditor } from "./approval-policy-editor";
import { approvalPolicyScope } from "./approval-policy-scope";
import { FilePatternsField } from "./file-patterns-field";

export function ApprovalPolicySettings() {
    const form = useFormContext<CodeReviewFormType>();
    const { field } = useController({
        name: "approvalPolicies.value",
        control: form.control,
    });
    const { field: sensitive } = useController({
        name: "approvalSensitivePaths.value",
        control: form.control,
    });
    const riskEnabled = useWatch({
        control: form.control,
        name: "riskAssessmentActive.value",
    });
    const legacyLabels = useWatch({
        control: form.control,
        name: "approvalLabels.value",
    });
    const legacyAuthors = useWatch({
        control: form.control,
        name: "approvalAuthors.value",
    });
    const labelsUnavailable = useApprovalLabelsUnavailable();
    const teamsUnavailable = useApprovalTeamsUnavailable();
    const policies: ApprovalPolicy[] = field.value ?? [
        {
            id: "legacy-approval",
            name: "Existing approval policy",
            enabled: true,
            labels: legacyLabels ?? [],
            authors: legacyAuthors ?? [],
        },
    ];
    const [editing, setEditing] = useState<ApprovalPolicy | "new" | null>(null);
    const update = (next: ApprovalPolicy[]) => field.onChange(next);
    const move = (index: number, direction: number) => {
        const next = [...policies];
        [next[index], next[index + direction]] = [
            next[index + direction],
            next[index],
        ];
        update(next);
    };

    return (
        <section className="space-y-4 px-5 py-5 sm:px-6">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    <h3 className="text-text-primary text-sm font-semibold">
                        Approval policies
                    </h3>
                    <OverrideIndicatorForm fieldName="approvalPolicies" />
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    leftIcon={<Plus className="size-4" />}
                    disabled={field.disabled || policies.length >= 50}
                    onClick={() => setEditing("new")}>
                    Add policy
                </Button>
            </div>
            <p className="text-text-secondary text-xs">
                A clean review and one matching policy are required.
                {riskEnabled
                    ? " Risk found or unavailable blocks approval."
                    : ""}
            </p>
            {policies.length === 0 && (
                <p className="text-text-secondary py-4 text-sm">
                    No policies. Add one to enable automatic approval.
                </p>
            )}
            <ol className="space-y-3">
                {policies.map((policy, index) => (
                    <li
                        key={policy.id}
                        className="border-card-lv3 rounded-xl border px-4 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="text-text-primary text-sm font-medium break-words">
                                        {policy.name}
                                    </h4>
                                    {!policy.enabled && (
                                        <Badge variant="helper">Off</Badge>
                                    )}
                                </div>
                                <p className="text-text-secondary mt-1 text-xs leading-5 break-words">
                                    {approvalPolicyScope(policy)}
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <Switch
                                    checked={policy.enabled}
                                    disabled={field.disabled}
                                    aria-label={`Enable ${policy.name}`}
                                    onCheckedChange={(enabled) =>
                                        update(
                                            policies.map((item) =>
                                                item.id === policy.id
                                                    ? { ...item, enabled }
                                                    : item,
                                            ),
                                        )
                                    }
                                />
                                <Button
                                    type="button"
                                    variant="cancel"
                                    size="sm"
                                    disabled={field.disabled}
                                    onClick={() => setEditing(policy)}>
                                    Edit
                                </Button>
                                <Button
                                    type="button"
                                    variant="cancel"
                                    size="sm"
                                    disabled={field.disabled}
                                    aria-label={`Delete ${policy.name}`}
                                    onClick={() =>
                                        update(
                                            policies.filter(
                                                (item) => item.id !== policy.id,
                                            ),
                                        )
                                    }>
                                    Delete
                                </Button>
                                {policies.length > 1 && (
                                    <div className="flex gap-1">
                                        <Button
                                            type="button"
                                            variant="cancel"
                                            size="sm"
                                            disabled={
                                                field.disabled || index === 0
                                            }
                                            aria-label={`Move ${policy.name} up`}
                                            onClick={() => move(index, -1)}>
                                            <ArrowUp className="size-3.5" />
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="cancel"
                                            size="sm"
                                            disabled={
                                                field.disabled ||
                                                index === policies.length - 1
                                            }
                                            aria-label={`Move ${policy.name} down`}
                                            onClick={() => move(index, 1)}>
                                            <ArrowDown className="size-3.5" />
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </li>
                ))}
            </ol>
            {policies.length > 1 && (
                <p className="text-text-secondary text-xs">
                    The first matching policy is used.
                </p>
            )}
            <details className="border-card-lv3 border-t pt-4">
                <summary className="text-text-secondary cursor-pointer text-xs">
                    Files requiring human approval
                </summary>
                <div className="mt-4">
                    <FilePatternsField
                        label="Always require human approval"
                        purpose="exclude"
                        value={sensitive.value ?? []}
                        disabled={sensitive.disabled}
                        onChange={sensitive.onChange}
                        hint="These files block every approval policy."
                    />
                </div>
            </details>
            {editing !== null && (
                <ApprovalPolicyEditor
                    policy={editing === "new" ? undefined : editing}
                    existingNames={policies
                        .filter(
                            (policy) =>
                                editing === "new" || policy.id !== editing.id,
                        )
                        .map((policy) => policy.name)}
                    labelsUnavailable={labelsUnavailable}
                    teamsUnavailable={teamsUnavailable}
                    onClose={() => setEditing(null)}
                    onApply={(policy) => {
                        update(
                            editing === "new"
                                ? [...policies, policy]
                                : policies.map((item) =>
                                      item.id === policy.id ? policy : item,
                                  ),
                        );
                        setEditing(null);
                    }}
                />
            )}
        </section>
    );
}
