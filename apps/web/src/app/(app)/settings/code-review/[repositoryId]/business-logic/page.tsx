"use client";

import { Suspense } from "react";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from "@components/ui/breadcrumb";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useBusinessLogicStatus } from "@services/business-logic/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useFormContext, useFormState } from "react-hook-form";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { PrOptions } from "./_components/pr-options";
import { StatusStrip } from "./_components/status-strip";
import { TaskSource } from "./_components/task-source";
import { TryIt } from "./_components/try-it";
import { Tune } from "./_components/tune";

function BusinessLogicContent() {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { teamId } = useSelectedTeamId();
    const form = useFormContext<CodeReviewFormType>();
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
    const status = useBusinessLogicStatus({ teamId, repositoryId });

    const {
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
        dirtyFields,
    } = useFormState({ control: form.control });
    const isDirty = Boolean(
        (dirtyFields as Record<string, unknown>).businessLogic,
    );

    useUnsavedChangesGuard({
        id: "business-logic",
        isDirty: isDirty || formIsSubmitting,
        onBlock: () => {
            document
                .querySelector("[data-header-actions]")
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
        },
    });

    const handleSubmit = form.handleSubmit(async (formData) => {
        try {
            const saveResult = await saveSettings(formData, {
                prepare: (data) => {
                    const { language: _language, ...config } = data;
                    const unformatted = unformatConfig(config);
                    return {
                        savedFormData: data,
                        codeReviewConfig: {
                            businessLogic: unformatted.businessLogic,
                        },
                    };
                },
            });

            if (saveResult?.centralizedPr) {
                toast(
                    getCentralizedPrToastPayload(
                        saveResult.centralizedPr,
                        "Change proposed through centralized pull request.",
                    ),
                );
                return;
            }

            toast({ description: "Settings saved", variant: "success" });
        } catch (error) {
            console.error("Error saving settings:", error);
            toast({
                title: "Error",
                description:
                    "An error occurred while saving the settings. Please try again.",
                variant: "danger",
            });
        }
    });

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    {/* Not in the sidebar: reached from "What to review". */}
                    <Breadcrumb className="mb-1">
                        <BreadcrumbList>
                            <BreadcrumbItem>
                                <BreadcrumbLink
                                    href={`/settings/code-review/${repositoryId}/review-scope${
                                        directoryId
                                            ? `?directoryId=${directoryId}`
                                            : ""
                                    }`}>
                                    What to review
                                </BreadcrumbLink>
                            </BreadcrumbItem>
                            <BreadcrumbSeparator />
                            <BreadcrumbItem>
                                <BreadcrumbPage>Business Logic</BreadcrumbPage>
                            </BreadcrumbItem>
                        </BreadcrumbList>
                    </Breadcrumb>
                    <Page.Title>Business Logic</Page.Title>
                    <Page.Description>
                        Kody checks each pull request against the task it
                        references, requirement by requirement.
                    </Page.Description>
                </Page.TitleContainer>

                <Page.SaveActions
                    isDirty={isDirty}
                    isSaving={formIsSubmitting}
                    canSave={canEdit && formIsValid}
                    onReset={() => form.resetField("businessLogic" as never)}
                    onSave={handleSubmit}
                />
            </Page.Header>

            <Page.Content className="gap-8">
                <CentralizedConfigReadOnlyAlert />
                <StatusStrip
                    status={status.data}
                    isLoading={status.isLoading}
                />
                <TaskSource teamId={teamId} canEdit={canEdit} />
                <PrOptions canEdit={canEdit} />
                <Tune canEdit={canEdit} />
                <TryIt
                    teamId={teamId}
                    repositoryId={repositoryId}
                    canEdit={canEdit}
                />
            </Page.Content>
        </Page.Root>
    );
}

export default function BusinessLogicPage() {
    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center py-10">
                    <Spinner className="size-6" />
                </div>
            }>
            <BusinessLogicContent />
        </Suspense>
    );
}
