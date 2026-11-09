"use client";

import { Suspense } from "react";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
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
import { ArrowUpRight, LockKeyholeIcon } from "lucide-react";
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
import { useReviewRouting, type Mode } from "./_components/use-review-routing";

type ModeField =
    | "reviewMode.value"
    | "riskReviewRouting.noRisk.value"
    | "riskReviewRouting.riskFound.value";
function ModeRow({
    label,
    name,
    fallback,
    disabled,
    description,
}: {
    label: string;
    name: ModeField;
    fallback: Mode;
    disabled: boolean;
    description?: string;
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
                    <div>
                        <div className="grid max-w-3xl items-start gap-4 py-5 sm:grid-cols-2">
                            <div>
                                <span className="text-text-primary text-sm font-medium">
                                    {label}
                                </span>
                                {description && (
                                    <p className="text-text-secondary mt-1 text-sm leading-6">
                                        {description}
                                    </p>
                                )}
                            </div>
                            <div className="space-y-2">
                                <Select
                                    value={field.value ?? fallback}
                                    onValueChange={field.onChange}
                                    disabled={disabled || field.disabled}>
                                    <SelectTrigger
                                        aria-label={label}
                                        className="max-w-48">
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
                                <p className="text-text-secondary text-sm break-words">
                                    {routing.modelFor(effective)}
                                </p>
                            </div>
                        </div>
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
                    const { byokModelId: _pin, ...withoutSyntheticPin } =
                        current;
                    return {
                        savedFormData:
                            !dirtyFields.byokModelId &&
                            !form.formState.defaultValues?.byokModelId
                                ? withoutSyntheticPin
                                : current,
                        codeReviewConfig: {
                            reviewMode: config.reviewMode ?? "balanced",
                            riskReviewRouting: config.riskReviewRouting,
                            ...(dirtyFields.byokModelId
                                ? { byokModelId: config.byokModelId }
                                : {}),
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
    if (!routing.canConfigure) {
        return (
            <Page.Root>
                <Page.Header>
                    <Page.TitleContainer>
                        <Page.Title>Routing</Page.Title>
                        <Page.Description>
                            Choose how Kody reviews each PR.
                        </Page.Description>
                    </Page.TitleContainer>
                </Page.Header>
                <Page.Content>
                    <Card color="lv1">
                        <CardHeader className="flex-row items-start gap-3">
                            <LockKeyholeIcon
                                aria-hidden
                                className="text-text-secondary mt-0.5 size-5 shrink-0"
                            />
                            <div className="flex flex-col gap-1">
                                <Heading variant="h3">
                                    Connect an AI provider to use routing
                                </Heading>
                                <p className="text-text-secondary text-sm">
                                    A connected provider is required to
                                    configure review modes and models.
                                </p>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {canEditModels ? (
                                <Link href="/byok" noHoverUnderline>
                                    <Button variant="primary" size="md">
                                        Connect AI provider
                                    </Button>
                                </Link>
                            ) : (
                                <p className="text-text-secondary text-sm">
                                    Ask an organization admin to connect a
                                    provider.
                                </p>
                            )}
                        </CardContent>
                    </Card>
                </Page.Content>
            </Page.Root>
        );
    }
    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Page.Title>Routing</Page.Title>
                    <Page.Description>
                        Choose how Kody reviews each PR.
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
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
                        <h2 className="text-text-primary text-base font-semibold">
                            Models
                        </h2>
                        {canEditModels && (
                            <Link
                                href="/byok?tab=routing"
                                className="text-text-secondary inline-flex items-center gap-1 text-sm">
                                Edit in AI providers{" "}
                                <ArrowUpRight className="size-3.5" />
                            </Link>
                        )}
                    </div>
                    <dl className="divide-card-lv3 divide-y text-sm">
                        {[
                            {
                                label: "Default model",
                                value: routing.defaultModel,
                            },
                            {
                                label: "Fallback model",
                                value: routing.fallbackModel,
                            },
                            ...(routing.active
                                ? [
                                      {
                                          label: "Risk assessment",
                                          value: routing.riskModelInherited
                                              ? "Uses default model"
                                              : routing.riskModel,
                                      },
                                  ]
                                : []),
                        ].map((model) => (
                            <div
                                key={model.label}
                                className="grid gap-2 py-3 sm:grid-cols-[12rem_1fr] sm:items-center">
                                <dt className="text-text-secondary">
                                    {model.label}
                                </dt>
                                <dd className="text-text-primary font-medium break-words">
                                    {model.value}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </Card>
                <Card color="lv1" className="px-5 py-5 sm:px-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <h2 className="text-text-primary text-base font-semibold">
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
                            className="text-text-secondary inline-flex items-center gap-1 text-sm">
                            Risk assessment: {routing.active ? "On" : "Off"}{" "}
                            <ArrowUpRight className="size-3.5" />
                        </Link>
                    </div>
                    <p className="text-text-secondary mt-2 text-sm leading-6">
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
                        <div className="border-card-lv3 border-t">
                            <ModeRow
                                label="Risk assessment unavailable"
                                description="Uses the default review mode. Automatic approval stays blocked."
                                name="reviewMode.value"
                                fallback="balanced"
                                disabled={!canEdit}
                            />
                        </div>
                    )}
                    <details className="border-card-lv3 border-t pt-4 text-sm">
                        <summary className="text-text-secondary cursor-pointer">
                            Manual commands
                        </summary>
                        <p className="text-text-secondary mt-3 leading-6">
                            An explicit <code>--heavy</code> or{" "}
                            <code>--balanced</code> command takes priority.
                        </p>
                    </details>
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
