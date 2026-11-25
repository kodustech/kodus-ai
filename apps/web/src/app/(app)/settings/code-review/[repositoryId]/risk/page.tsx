"use client";

import { Suspense, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useDefaultRiskCriteria } from "@services/risk-assessment/hooks";
import type { RiskCriterion } from "@services/risk-assessment/types";
import { PlusIcon } from "lucide-react";
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
import {
    applyRiskRule,
    resetRiskRule,
    riskRuleRows,
    type RiskRuleRow,
} from "./_utils/risk-rules";

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
    const [editing, setEditing] = useState<RiskRuleRow | "new" | null>(null);
    const [previewing, setPreviewing] = useState(false);
    const defaultRules = useDefaultRiskCriteria();
    const defaults = defaultRules.data ?? [];
    const rows = riskRuleRows(defaults, criteria);
    const updateCriteria = (next: RiskCriterion[]) =>
        criteriaField.onChange(next);
    const updateRule = (rule: RiskCriterion) =>
        updateCriteria(applyRiskRule(defaults, criteria, rule));
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
                        Kody assesses each PR against Kodus’s risk rules and
                        your team’s.
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
            <Page.Content className="gap-6">
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
                                    <Badge variant="primary-dark">Beta</Badge>
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
                <Card color="lv1" aria-labelledby="risk-rules-title">
                    <CardHeader className="flex-row flex-wrap items-start justify-between gap-4">
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-2">
                                <Heading variant="h3" id="risk-rules-title">
                                    Risk rules
                                </Heading>
                                <OverrideIndicatorForm
                                    fieldName="riskCriteria"
                                    disabled={!active || !canConfigure}
                                />
                            </div>
                            <p className="text-text-secondary text-sm">
                                {active
                                    ? "Kody finds risk when a PR falls under an enabled rule. Turn off or edit Kodus’s rules, or add your team’s."
                                    : "Saved rules are not used while assessment is off."}
                            </p>
                        </div>
                        <Button
                            type="button"
                            size="md"
                            variant="primary"
                            leftIcon={<PlusIcon />}
                            disabled={
                                !active ||
                                !canConfigure ||
                                criteria.length >= 50
                            }
                            onClick={() => setEditing("new")}>
                            Add rule
                        </Button>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        {defaultRules.isLoading && <Spinner />}
                        {defaultRules.isError && (
                            <p className="text-text-secondary text-sm">
                                Could not load Kodus’s rules. Your team’s rules
                                are below.
                            </p>
                        )}
                        {rows.length > 0 && (
                            <ul
                                aria-label="Risk rules"
                                className="border-card-lv3/60 divide-card-lv3/60 flex flex-col divide-y overflow-hidden rounded-xl border">
                                {rows.map((rule) => (
                                    <li
                                        key={rule.id}
                                        className="flex flex-col gap-3 p-5">
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="flex items-center gap-2">
                                                <h3 className="text-sm font-semibold">
                                                    {rule.name}
                                                </h3>
                                                {rule.isDefault && (
                                                    <Badge variant="secondary">
                                                        {rule.edited
                                                            ? "Kodus · edited"
                                                            : "Kodus"}
                                                    </Badge>
                                                )}
                                                {(!active || !rule.enabled) && (
                                                    <Badge variant="helper">
                                                        {rule.enabled
                                                            ? "Paused"
                                                            : "Off"}
                                                    </Badge>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <Switch
                                                    aria-label={`Enable ${rule.name}`}
                                                    checked={rule.enabled}
                                                    disabled={
                                                        !active || !canConfigure
                                                    }
                                                    onCheckedChange={(
                                                        enabled,
                                                    ) =>
                                                        updateRule({
                                                            ...rule,
                                                            enabled,
                                                        })
                                                    }
                                                />
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="cancel"
                                                    disabled={
                                                        !active || !canConfigure
                                                    }
                                                    aria-label={`Edit ${rule.name}`}
                                                    onClick={() =>
                                                        setEditing(rule)
                                                    }>
                                                    Edit
                                                </Button>
                                                {rule.isDefault ? (
                                                    rule.edited && (
                                                        <Button
                                                            type="button"
                                                            size="sm"
                                                            variant="cancel"
                                                            disabled={
                                                                !active ||
                                                                !canConfigure
                                                            }
                                                            aria-label={`Reset ${rule.name}`}
                                                            onClick={() =>
                                                                updateCriteria(
                                                                    resetRiskRule(
                                                                        defaults,
                                                                        criteria,
                                                                        rule.id,
                                                                    ),
                                                                )
                                                            }>
                                                            Reset
                                                        </Button>
                                                    )
                                                ) : (
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="cancel"
                                                        disabled={
                                                            !active ||
                                                            !canConfigure
                                                        }
                                                        aria-label={`Delete ${rule.name}`}
                                                        onClick={() =>
                                                            updateCriteria(
                                                                criteria.filter(
                                                                    (item) =>
                                                                        item.id !==
                                                                        rule.id,
                                                                ),
                                                            )
                                                        }>
                                                        Delete
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                        <p className="text-text-secondary text-sm leading-6 whitespace-pre-wrap">
                                            {rule.instructions}
                                        </p>
                                        {!!(
                                            rule.includedFiles?.length ||
                                            rule.excludedFiles?.length
                                        ) && (
                                            <details className="border-card-lv3 border-t pt-3 text-xs">
                                                <summary className="text-text-secondary cursor-pointer">
                                                    File filters
                                                </summary>
                                                <div className="mt-3 flex flex-col gap-2">
                                                    {!!rule.includedFiles
                                                        ?.length && (
                                                        <p>
                                                            Included:{" "}
                                                            <code>
                                                                {rule.includedFiles.join(
                                                                    ", ",
                                                                )}
                                                            </code>
                                                        </p>
                                                    )}
                                                    {!!rule.excludedFiles
                                                        ?.length && (
                                                        <p>
                                                            Excluded:{" "}
                                                            <code>
                                                                {rule.excludedFiles.join(
                                                                    ", ",
                                                                )}
                                                            </code>
                                                        </p>
                                                    )}
                                                </div>
                                            </details>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardContent>
                </Card>
            </Page.Content>
            {editing && (
                <CriterionDialog
                    criterion={editing === "new" ? undefined : editing}
                    onClose={() => setEditing(null)}
                    onApply={(rule) => {
                        updateRule(rule);
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
