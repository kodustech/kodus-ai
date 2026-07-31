"use client";

import { Card, CardHeader } from "@components/ui/card";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { AlertTriangleIcon, SaveIcon } from "lucide-react";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useFormContext, useFormState } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { unformatConfig } from "src/core/utils/helpers";
import { LinkedRepositories } from "src/features/ee/linked-repositories";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { useCodeReviewRouteParams } from "../../../_hooks";

/**
 * Cross-repo context (#1576) — dedicated settings page for linked
 * repositories. Repo-scoped only: relationships are directional, so a
 * global default would link every repository to the same siblings.
 */
export default function LinkedRepositoriesPage() {
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
    const {
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
        dirtyFields,
    } = useFormState({ control: form.control });

    const isDirty = Boolean(dirtyFields.linkedRepositories);

    useUnsavedChangesGuard({
        id: "linked-repositories",
        isDirty: isDirty || formIsSubmitting,
        onBlock: () => {
            document
                .querySelector('[data-field-name="linkedRepositories"]')
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
                            linkedRepositories:
                                unformatted.linkedRepositories,
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

    // The route exists under /global/* too (shared [repositoryId] segment),
    // but the feature is repo-scoped — explain instead of rendering a form
    // whose save would create a surprising org-wide default.
    if (repositoryId === "global") {
        return (
            <Page.Root>
                <Page.Header>
                    <CodeReviewPagesBreadcrumb pageName="Linked Repositories" />
                </Page.Header>
                <Page.Header>
                    <Page.Title>Linked Repositories</Page.Title>
                </Page.Header>
                <Page.Content>
                    <Card className="bg-warning/10 text-sm">
                        <CardHeader className="flex-row items-center gap-4">
                            <AlertTriangleIcon className="text-warning size-5" />
                            <span>
                                Linked repositories are configured per
                                repository — relationships are directional, so
                                there is no global default. Pick a repository
                                in the sidebar to configure its links.
                            </span>
                        </CardHeader>
                    </Card>
                </Page.Content>
            </Page.Root>
        );
    }

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Linked Repositories" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Linked Repositories</Page.Title>

                <Page.HeaderActions>
                    <CodeReviewSaveButton
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSubmit}
                        disabled={!canEdit || !isDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="gap-8">
                <CentralizedConfigReadOnlyAlert />
                <div data-field-name="linkedRepositories">
                    <LinkedRepositories />
                </div>
            </Page.Content>
        </Page.Root>
    );
}
