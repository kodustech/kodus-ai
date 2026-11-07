"use client";

import { Suspense } from "react";
import { Card } from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Link } from "@components/ui/link";
import { Page } from "@components/ui/page";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { ArrowUpRight } from "lucide-react";
import { Controller, useFormContext, useFormState } from "react-hook-form";
import { useCodeReviewModelData } from "src/app/(app)/settings/_components/context";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { OverrideIndicatorForm } from "../../_components/override";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import type { CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { BYOKModelSelectorSection } from "../general/_components/byok-model-selector";
import { confirmOffCatalogModelSave } from "../general/_components/confirm-scope-model";
import {
    modeLabel,
    useReviewRouting,
    type Mode,
} from "./_components/use-review-routing";

type ModeField =
    | "reviewMode.value"
    | "riskReviewRouting.noRisk.value"
    | "riskReviewRouting.riskFound.value";
function ModeRow({
    label,
    name,
    fallback,
    disabled,
}: {
    label: string;
    name: ModeField;
    fallback: Mode;
    disabled: boolean;
}) {
    const form = useFormContext<CodeReviewFormType>();
    const routing = useReviewRouting();
    return (
        <Controller
            name={name}
            control={form.control}
            defaultValue={fallback}
            render={({ field }) => {
                const effective = routing.effectiveMode(
                    field.value ?? fallback,
                );
                return (
                    <div className="grid items-center gap-3 py-4 sm:grid-cols-[1fr_12rem_1fr]">
                        <span className="text-text-primary text-sm">
                            {label}
                        </span>
                        <Select
                            value={field.value ?? fallback}
                            onValueChange={field.onChange}
                            disabled={disabled || field.disabled}>
                            <SelectTrigger aria-label={label}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="balanced">
                                    Balanced
                                </SelectItem>
                                <SelectItem
                                    value="heavy"
                                    disabled={!routing.heavyAllowed}>
                                    Heavy
                                    {!routing.heavyAllowed
                                        ? " · Teams/Enterprise"
                                        : ""}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <span className="text-text-secondary text-xs sm:text-right">
                            {routing.modelFor(effective)}
                        </span>
                    </div>
                );
            }}
        />
    );
}

function RoutingSettings() {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { teamId } = useSelectedTeamId();
    const form = useFormContext<CodeReviewFormType>();
    const { dirtyFields, isSubmitting, isValid } = useFormState({
        control: form.control,
    });
    const routing = useReviewRouting();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const { llmConfigStatus } = useCodeReviewModelData();
    const canEditModels = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });
    const riskHref = `/settings/code-review/${encodeURIComponent(repositoryId)}/risk${directoryId ? `?directoryId=${encodeURIComponent(directoryId)}` : ""}`;
    const submit = form.handleSubmit(async (data) => {
        try {
            const model = data.byokModelId?.value;
            const models = llmConfigStatus?.models ?? [];
            if (
                dirtyFields.byokModelId &&
                model &&
                models.length &&
                !models.some(
                    (entry) => entry.modelId === model || entry.model === model,
                )
            ) {
                if (!(await confirmOffCatalogModelSave(model))) return;
            }
            const result = await saveSettings(data, {
                prepare: (current) => {
                    const config = unformatConfig(current);
                    return {
                        savedFormData: current,
                        codeReviewConfig: {
                            reviewMode: config.reviewMode ?? "balanced",
                            riskReviewRouting: config.riskReviewRouting,
                            byokModelId: config.byokModelId,
                            byokModel: config.byokModel,
                        },
                    };
                },
            });
            toast(
                result?.centralizedPr
                    ? getCentralizedPrToastPayload(
                          result.centralizedPr,
                          "Routing change proposed.",
                      )
                    : { description: "Settings saved", variant: "success" },
            );
        } catch {
            toast({
                description: "Could not save routing. Try again.",
                variant: "danger",
            });
        }
    });
    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Page.Title>Routing</Page.Title>
                    <Page.Description>
                        Review modes and models.
                    </Page.Description>
                </Page.TitleContainer>
                <Page.SaveActions
                    isDirty={
                        !!(
                            dirtyFields.reviewMode ||
                            dirtyFields.riskReviewRouting ||
                            dirtyFields.byokModelId ||
                            dirtyFields.byokModel
                        )
                    }
                    isSaving={isSubmitting}
                    canSave={canEdit && isValid}
                    onSave={submit}
                    onReset={() => {
                        form.resetField("reviewMode");
                        form.resetField("riskReviewRouting");
                        form.resetField("byokModelId");
                        form.resetField("byokModel");
                    }}
                />
            </Page.Header>
            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />
                <Card color="lv1" className="px-5 py-5 sm:px-6">
                    <div className="mb-4 flex items-center justify-between gap-4">
                        <h2 className="text-text-primary text-sm font-semibold">
                            Organization models
                        </h2>
                        {canEditModels && (
                            <Link
                                href="/byok?tab=routing"
                                className="text-text-secondary inline-flex items-center gap-1 text-xs">
                                Edit models{" "}
                                <ArrowUpRight className="size-3.5" />
                            </Link>
                        )}
                    </div>
                    <dl className="grid gap-4 text-sm sm:grid-cols-2">
                        <div>
                            <dt className="text-text-secondary mb-1 text-xs">
                                Default model
                            </dt>
                            <dd>{routing.defaultModel}</dd>
                        </div>
                        <div>
                            <dt className="text-text-secondary mb-1 text-xs">
                                Fallback model
                            </dt>
                            <dd>{routing.fallbackModel}</dd>
                        </div>
                        {routing.active && (
                            <div>
                                <dt className="text-text-secondary mb-1 text-xs">
                                    Risk assessment model
                                </dt>
                                <dd>{routing.riskModel}</dd>
                            </div>
                        )}
                    </dl>
                </Card>
                <Card color="lv1" className="px-5 py-5 sm:px-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <h2 className="text-text-primary text-sm font-semibold">
                                Review mode
                            </h2>
                            <OverrideIndicatorForm
                                fieldName={
                                    routing.active
                                        ? "riskReviewRouting"
                                        : "reviewMode"
                                }
                            />
                        </div>
                        <Link
                            href={riskHref}
                            className="text-text-secondary inline-flex items-center gap-1 text-xs">
                            Risk assessment: {routing.active ? "On" : "Off"}{" "}
                            <ArrowUpRight className="size-3.5" />
                        </Link>
                    </div>
                    <p className="text-text-secondary mt-2 text-xs">
                        {routing.active
                            ? "Review mode follows the risk result."
                            : "One mode applies to all PRs."}
                    </p>
                    <div className="divide-card-lv3 mt-2 divide-y">
                        {routing.active ? (
                            <>
                                <ModeRow
                                    label="No risk found"
                                    name="riskReviewRouting.noRisk.value"
                                    fallback="balanced"
                                    disabled={!canEdit}
                                />
                                <ModeRow
                                    label="Risk found"
                                    name="riskReviewRouting.riskFound.value"
                                    fallback="heavy"
                                    disabled={!canEdit}
                                />
                            </>
                        ) : (
                            <ModeRow
                                label="All PRs"
                                name="reviewMode.value"
                                fallback="balanced"
                                disabled={!canEdit}
                            />
                        )}
                    </div>
                    {routing.active && (
                        <details className="border-card-lv3 mt-2 border-t pt-4">
                            <summary className="text-text-secondary cursor-pointer text-xs">
                                Default review mode ·{" "}
                                {modeLabel(routing.defaultMode)}
                            </summary>
                            <FormControl.Helper>
                                Used when risk assessment has no result.
                            </FormControl.Helper>
                            <ModeRow
                                label="Default review mode"
                                name="reviewMode.value"
                                fallback="balanced"
                                disabled={!canEdit}
                            />
                        </details>
                    )}
                    <p className="text-text-secondary mt-4 text-xs">
                        <code>--heavy</code> and <code>--balanced</code>{" "}
                        override the mode.
                    </p>
                </Card>
                {repositoryId !== "global" && <BYOKModelSelectorSection />}
            </Page.Content>
        </Page.Root>
    );
}

export default function RoutingPage() {
    return (
        <Suspense fallback={<Spinner />}>
            <RoutingSettings />
        </Suspense>
    );
}
