"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
import { getLLMConfigStatus } from "@services/organizationParameters/fetch";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, LockKeyholeIcon } from "lucide-react";
import {
    Controller,
    useFormContext,
    useFormState,
    useWatch,
} from "react-hook-form";
import { useCodeReviewModelData } from "src/app/(app)/settings/_components/context";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";
import { PerRepositoryPanel } from "src/features/ee/byok/_components/per-repository-panel";
import {
    hasRoutingProvider,
    routingHref,
    routingStatusQueryKey,
} from "src/features/ee/byok/_components/routing/routing-state";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { OverrideIndicatorForm } from "../../_components/override";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import type { CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { BYOKModelSelectorSection } from "../general/_components/byok-model-selector";
import { confirmOffCatalogModelSave } from "../general/_components/confirm-scope-model";
import {
    OrganizationModels,
    OtherTaskModels,
} from "./_components/organization-models";
import { useOrganizationRouting } from "./_components/use-organization-routing";
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
    description,
    modelFor,
}: {
    label: string;
    name: ModeField;
    fallback: Mode;
    disabled: boolean;
    description?: string;
    modelFor?: (mode: Mode) => string;
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
                                        <SelectValue>
                                            {modeLabel(effective)}
                                        </SelectValue>
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
                                    {(modelFor ?? routing.modelFor)(effective)}
                                </p>
                                {(field.value ?? fallback) === "heavy" &&
                                    !routing.heavyAllowed && (
                                        <p className="text-text-secondary text-xs">
                                            Heavy requires Teams or Enterprise.
                                            Reviews use Balanced.
                                        </p>
                                    )}
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
    const router = useRouter();
    const queryClient = useQueryClient();
    const [saving, setSaving] = useState(false);
    const form = useFormContext<CodeReviewFormType>();
    const [scopePin, legacyPin] = useWatch({
        control: form.control,
        name: ["byokModelId.value", "byokModel.value"],
    });
    const { dirtyFields, isSubmitting, isValid } = useFormState({
        control: form.control,
    });
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const {
        llmConfigStatus,
        hasConnectedProvider,
        isCheckingProvider,
        providerStatusError,
    } = useCodeReviewModelData();
    const canCreateModels = usePermission(
        Action.Create,
        ResourceType.OrganizationSettings,
    );
    const canReadModels = usePermission(
        Action.Read,
        ResourceType.OrganizationSettings,
    );
    const canEditModels = canCreateModels && canReadModels;
    const globalScope = repositoryId === "global" && !directoryId;
    const organization = useOrganizationRouting({
        teamId,
        enabled: globalScope && canReadModels && hasConnectedProvider,
        canEdit:
            canEditModels &&
            hasConnectedProvider &&
            !isCheckingProvider &&
            !providerStatusError,
        status: llmConfigStatus,
    });
    const routing = useReviewRouting(
        organization.dirty ? organization.routing : undefined,
    );
    useEffect(() => {
        const scrollToAnchor = () => {
            let anchor: string;
            try {
                anchor = decodeURIComponent(window.location.hash.slice(1));
            } catch {
                return;
            }
            if (!/^(default|fallback|task:[a-zA-Z]+)$/.test(anchor)) return;
            const element = [
                ...document.querySelectorAll<HTMLElement>(
                    "[data-routing-anchor]",
                ),
            ].find((node) => node.dataset.routingAnchor === anchor);
            const details = element?.closest("details");
            if (details) details.open = true;
            element?.scrollIntoView({ block: "center" });
        };
        scrollToAnchor();
        window.addEventListener("hashchange", scrollToAnchor);
        return () => window.removeEventListener("hashchange", scrollToAnchor);
    }, [organization.ready]);
    const reviewDirty = !!(
        dirtyFields.reviewMode ||
        dirtyFields.riskReviewRouting ||
        dirtyFields.byokModelId ||
        dirtyFields.byokModel
    );
    const anyDirty = reviewDirty || organization.dirty;
    const reset = () => {
        form.resetField("reviewMode");
        form.resetField("riskReviewRouting");
        form.resetField("byokModelId");
        form.resetField("byokModel");
        organization.reset();
    };
    const refreshStatus = () =>
        queryClient.fetchQuery({
            queryKey: routingStatusQueryKey(teamId),
            queryFn: getLLMConfigStatus,
            staleTime: 0,
        });
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });
    const riskHref = `/settings/code-review/${encodeURIComponent(repositoryId)}/risk${directoryId ? `?directoryId=${encodeURIComponent(directoryId)}` : ""}`;
    const save = async (data: CodeReviewFormType) => {
        let modelsSaved = false;
        let checkingSavedModels = false;
        setSaving(true);
        try {
            const freshStatus = await refreshStatus();
            if (!hasRoutingProvider(freshStatus)) {
                toast({
                    variant: "warning",
                    description:
                        "Connect an AI provider before changing routing.",
                });
                return;
            }
            if (reviewDirty && !canEdit)
                throw new Error("You cannot edit review settings.");
            const model = data.byokModelId?.value;
            const models = freshStatus.models;
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
            modelsSaved = await organization.save(freshStatus);
            if (modelsSaved) {
                checkingSavedModels = true;
                const savedStatus = await refreshStatus();
                if (!hasRoutingProvider(savedStatus))
                    throw new Error(
                        "Connect an AI provider before changing routing.",
                    );
                checkingSavedModels = false;
            }
            const result = reviewDirty
                ? await saveSettings(data, {
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
                  })
                : undefined;
            toast(
                result?.centralizedPr
                    ? getCentralizedPrToastPayload(
                          result.centralizedPr,
                          "Routing change proposed.",
                      )
                    : {
                          description: "Settings saved",
                          variant: "success",
                      },
            );
        } catch (error) {
            toast({
                description: modelsSaved
                    ? checkingSavedModels
                        ? reviewDirty
                            ? "Models saved. Could not verify provider status. Review settings are still unsaved."
                            : "Models saved. Refresh provider status to continue."
                        : "Models saved. Review settings could not be saved. Try again."
                    : error instanceof Error
                      ? error.message
                      : "Could not save routing. Try again.",
                variant: "danger",
            });
        } finally {
            if (modelsSaved) router.refresh();
            setSaving(false);
        }
    };
    const submit = () =>
        reviewDirty ? form.handleSubmit(save)() : save(form.getValues());
    if (
        (!llmConfigStatus && isCheckingProvider) ||
        (!llmConfigStatus && !providerStatusError)
    ) {
        return (
            <Page.Root>
                <Page.Header>
                    <Page.Title>Routing</Page.Title>
                </Page.Header>
                <Page.Content>
                    <Spinner />
                </Page.Content>
            </Page.Root>
        );
    }
    if (!routing.canConfigure || providerStatusError) {
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
                                    {providerStatusError
                                        ? "Could not verify AI providers"
                                        : "Connect an AI provider to use routing"}
                                </Heading>
                                <p className="text-text-secondary text-sm">
                                    {providerStatusError
                                        ? "Retry before changing routing settings."
                                        : "A connected provider is required to configure review modes and models."}
                                </p>
                            </div>
                        </CardHeader>
                        <CardContent>
                            {anyDirty &&
                                (providerStatusError || !canEditModels) && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="helper"
                                        className="mb-3"
                                        onClick={reset}>
                                        Discard changes
                                    </Button>
                                )}
                            {providerStatusError ? (
                                <Button
                                    type="button"
                                    size="md"
                                    variant="primary"
                                    onClick={() =>
                                        refreshStatus().catch(() => undefined)
                                    }>
                                    Retry
                                </Button>
                            ) : canEditModels && anyDirty ? (
                                <Button
                                    type="button"
                                    size="md"
                                    variant="primary"
                                    onClick={() => {
                                        reset();
                                        router.push("/byok");
                                    }}>
                                    Discard changes and connect
                                </Button>
                            ) : canEditModels ? (
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
                    isDirty={anyDirty}
                    isSaving={saving || isSubmitting}
                    canSave={
                        !isCheckingProvider &&
                        !saving &&
                        (!reviewDirty || (canEdit && isValid)) &&
                        (!organization.dirty ||
                            (organization.canEdit &&
                                !organization.validationError))
                    }
                    onSave={submit}
                    onReset={reset}
                />
            </Page.Header>
            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />
                {globalScope && canReadModels ? (
                    <OrganizationModels
                        controller={organization}
                        heavyAllowed={routing.heavyAllowed}
                        canEdit={canEditModels}
                    />
                ) : (
                    <Card color="lv1">
                        <CardHeader className="flex-row flex-wrap items-center justify-between gap-4">
                            <Heading variant="h3">Organization models</Heading>
                            {!globalScope && (
                                <Link
                                    href={routingHref()}
                                    className="text-text-secondary inline-flex items-center gap-1 text-sm">
                                    View organization routing{" "}
                                    <ArrowUpRight className="size-3.5" />
                                </Link>
                            )}
                        </CardHeader>
                        <CardContent>
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
                        </CardContent>
                    </Card>
                )}
                <Card color="lv1">
                    <CardHeader>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                                <Heading variant="h3">Review mode</Heading>
                                <OverrideIndicatorForm
                                    disabled={
                                        !canEdit ||
                                        !!isCheckingProvider ||
                                        saving
                                    }
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
                    </CardHeader>
                    <CardContent>
                        <div className="divide-card-lv3 mt-2 divide-y">
                            {routing.active ? (
                                <>
                                    <ModeRow
                                        label="No risk found"
                                        name="riskReviewRouting.noRisk.value"
                                        fallback="balanced"
                                        disabled={
                                            !canEdit ||
                                            !!isCheckingProvider ||
                                            saving
                                        }
                                        modelFor={routing.modelFor}
                                    />
                                    <ModeRow
                                        label="Risk found"
                                        name="riskReviewRouting.riskFound.value"
                                        fallback="heavy"
                                        disabled={
                                            !canEdit ||
                                            !!isCheckingProvider ||
                                            saving
                                        }
                                        modelFor={routing.modelFor}
                                    />
                                </>
                            ) : (
                                <ModeRow
                                    label="All PRs"
                                    name="reviewMode.value"
                                    fallback="balanced"
                                    disabled={
                                        !canEdit ||
                                        !!isCheckingProvider ||
                                        saving
                                    }
                                    modelFor={routing.modelFor}
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
                                    disabled={
                                        !canEdit ||
                                        !!isCheckingProvider ||
                                        saving
                                    }
                                    modelFor={routing.modelFor}
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
                    </CardContent>
                </Card>
                {(!globalScope || scopePin || legacyPin) && (
                    <BYOKModelSelectorSection
                        disabled={!!isCheckingProvider || saving}
                    />
                )}
                {globalScope && canReadModels && (
                    <OtherTaskModels
                        controller={organization}
                        heavyAllowed={routing.heavyAllowed}
                        canEdit={canEditModels}
                    />
                )}
                {globalScope && canReadModels && organization.ready && (
                    <PerRepositoryPanel
                        teamId={teamId}
                        models={organization.pool.map(
                            ({ id, label, provider }) => ({
                                id,
                                label,
                                provider,
                            }),
                        )}
                    />
                )}
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
