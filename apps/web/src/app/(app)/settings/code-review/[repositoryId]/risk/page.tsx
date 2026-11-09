"use client";

import { Suspense, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { RiskCriterion } from "@services/risk-assessment/types";
import {
    Controller,
    useController,
    useFormContext,
    useFormState,
    useWatch,
} from "react-hook-form";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";
import { isTeamsOrEnterprisePlan } from "src/features/ee/byok/_utils";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { OverrideIndicatorForm } from "../../_components/override";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import type { CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { SettingToggleRow } from "../general/_components/setting-toggle-row";
import { CriterionDialog } from "./_components/criterion-dialog";
import { RiskPreview } from "./_components/risk-preview";

function RiskSettings() {
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const form = useFormContext<CodeReviewFormType>();
    const { dirtyFields, isSubmitting, isValid } = useFormState({
        control: form.control,
    });
    const active =
        useWatch({
            control: form.control,
            name: "riskAssessmentActive.value",
        }) ?? false;
    // Register the array as one field so refetches preserve removals as edits.
    const { field: criteriaField } = useController({
        control: form.control,
        name: "riskCriteria.value",
        defaultValue: [],
    });
    const criteria = criteriaField.value ?? [];
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const { license } = useSubscriptionContext();
    const betaEnabled = useFeatureFlags().conditionalPrApproval === true;
    const planAllowed = isTeamsOrEnterprisePlan(license);
    const available = betaEnabled && planAllowed;
    const canConfigure = canEdit && available;
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });
    const [editing, setEditing] = useState<RiskCriterion | "new" | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const updateCriteria = (next: RiskCriterion[]) =>
        criteriaField.onChange(next);
    const submit = form.handleSubmit(async (data) => {
        try {
            const result = await saveSettings(data, {
                prepare: (current) => {
                    const config = unformatConfig(current);
                    return {
                        savedFormData: current,
                        codeReviewConfig: {
                            riskAssessmentActive:
                                config.riskAssessmentActive ?? false,
                            riskCriteria: config.riskCriteria ?? [],
                        },
                    };
                },
            });
            toast(
                result?.centralizedPr
                    ? getCentralizedPrToastPayload(
                          result.centralizedPr,
                          "Change proposed through centralized pull request.",
                      )
                    : { description: "Settings saved", variant: "success" },
            );
        } catch {
            toast({
                description: "Could not save risk settings. Try again.",
                variant: "danger",
            });
        }
    });
    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Page.Title>Risk assessment</Page.Title>
                    <Page.Description>
                        Kody assesses PR risk, with or without team criteria.
                    </Page.Description>
                </Page.TitleContainer>
                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        type="button"
                        size="md"
                        variant="helper"
                        disabled={!active || !canConfigure}
                        onClick={() => setPreviewing(true)}>
                        Preview on a PR
                    </Button>
                    <Page.SaveActions
                        isDirty={
                            !!(
                                dirtyFields.riskAssessmentActive ||
                                dirtyFields.riskCriteria
                            )
                        }
                        isSaving={isSubmitting}
                        canSave={canEdit && isValid}
                        onSave={submit}
                        onReset={() => {
                            form.resetField("riskAssessmentActive");
                            form.resetField("riskCriteria");
                        }}
                    />
                </div>
            </Page.Header>
            <Page.Content className="max-w-5xl gap-6">
                <CentralizedConfigReadOnlyAlert />
                <Card color="lv1">
                    <Controller
                        name="riskAssessmentActive.value"
                        control={form.control}
                        render={({ field }) => (
                            <SettingToggleRow
                                id="risk-assessment-active"
                                title="Risk assessment"
                                fieldName="riskAssessmentActive"
                                badge={
                                    <Badge
                                        variant={
                                            active ? "primary-dark" : "helper"
                                        }>
                                        {active ? "On" : "Off"}
                                    </Badge>
                                }
                                description={
                                    !available
                                        ? planAllowed
                                            ? "Risk assessment is not enabled for this workspace."
                                            : "Risk assessment is available on Teams and Enterprise."
                                        : active
                                          ? "Assesses each PR independently of automatic approval."
                                          : "PR risk is not assessed."
                                }
                                checked={field.value ?? false}
                                disabled={
                                    !canEdit ||
                                    field.disabled ||
                                    (!available && !field.value)
                                }
                                onCheckedChange={field.onChange}
                            />
                        )}
                    />
                </Card>
                <section className="flex flex-col gap-4">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-sm font-semibold">
                                    Team criteria{" "}
                                    <span className="text-text-secondary font-normal">
                                        · optional
                                    </span>
                                </h2>
                                <OverrideIndicatorForm fieldName="riskCriteria" />
                            </div>
                            <p className="text-text-secondary mt-1 text-sm">
                                {active
                                    ? "Add context to Kody’s assessment."
                                    : "Saved criteria are not used while assessment is off."}
                            </p>
                        </div>
                        <Button
                            type="button"
                            size="md"
                            variant="primary"
                            disabled={
                                !active ||
                                !canConfigure ||
                                criteria.length >= 50
                            }
                            onClick={() => setEditing("new")}>
                            Add criterion
                        </Button>
                    </div>
                    {criteria.length === 0 && (
                        <p className="text-text-secondary text-sm">
                            {active
                                ? "No team criteria. Kody uses the PR diff and code context."
                                : "No team criteria."}
                        </p>
                    )}
                    {criteria.map((criterion) => (
                        <Card
                            key={criterion.id}
                            color="lv1"
                            className="flex flex-col gap-3 p-5">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <h3 className="text-sm font-semibold">
                                        {criterion.name}
                                    </h3>
                                    {(!active || !criterion.enabled) && (
                                        <Badge variant="helper">
                                            {criterion.enabled
                                                ? "Paused"
                                                : "Off"}
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex items-center gap-3">
                                    <Switch
                                        aria-label={`Enable ${criterion.name}`}
                                        checked={criterion.enabled}
                                        disabled={!active || !canConfigure}
                                        onCheckedChange={(enabled) =>
                                            updateCriteria(
                                                criteria.map((item) =>
                                                    item.id === criterion.id
                                                        ? { ...item, enabled }
                                                        : item,
                                                ),
                                            )
                                        }
                                    />
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="cancel"
                                        disabled={!active || !canConfigure}
                                        aria-label={`Edit ${criterion.name}`}
                                        onClick={() => setEditing(criterion)}>
                                        Edit
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="cancel"
                                        disabled={!active || !canConfigure}
                                        aria-label={`Delete ${criterion.name}`}
                                        onClick={() =>
                                            updateCriteria(
                                                criteria.filter(
                                                    (item) =>
                                                        item.id !==
                                                        criterion.id,
                                                ),
                                            )
                                        }>
                                        Delete
                                    </Button>
                                </div>
                            </div>
                            <p className="text-text-secondary text-sm leading-6 whitespace-pre-wrap">
                                {criterion.instructions}
                            </p>
                            {!!(
                                criterion.includedFiles?.length ||
                                criterion.excludedFiles?.length
                            ) && (
                                <details className="border-card-lv3 border-t pt-3 text-xs">
                                    <summary className="text-text-secondary cursor-pointer">
                                        File filters
                                    </summary>
                                    <div className="mt-3 flex flex-col gap-2">
                                        {!!criterion.includedFiles?.length && (
                                            <p>
                                                Included:{" "}
                                                <code>
                                                    {criterion.includedFiles.join(
                                                        ", ",
                                                    )}
                                                </code>
                                            </p>
                                        )}
                                        {!!criterion.excludedFiles?.length && (
                                            <p>
                                                Excluded:{" "}
                                                <code>
                                                    {criterion.excludedFiles.join(
                                                        ", ",
                                                    )}
                                                </code>
                                            </p>
                                        )}
                                    </div>
                                </details>
                            )}
                        </Card>
                    ))}
                </section>
            </Page.Content>
            {editing && (
                <CriterionDialog
                    criterion={editing === "new" ? undefined : editing}
                    onClose={() => setEditing(null)}
                    onApply={(criterion) => {
                        updateCriteria(
                            editing === "new"
                                ? [...criteria, criterion]
                                : criteria.map((item) =>
                                      item.id === criterion.id
                                          ? criterion
                                          : item,
                                  ),
                        );
                        setEditing(null);
                    }}
                />
            )}
            {previewing && (
                <RiskPreview
                    teamId={teamId}
                    repositoryId={repositoryId}
                    criteria={criteria}
                    onClose={() => setPreviewing(false)}
                />
            )}
        </Page.Root>
    );
}

export default function RiskPage() {
    return (
        <Suspense fallback={<Spinner />}>
            <RiskSettings />
        </Suspense>
    );
}
