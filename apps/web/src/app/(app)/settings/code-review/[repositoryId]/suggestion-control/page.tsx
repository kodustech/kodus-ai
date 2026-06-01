"use client";

import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { KodyLearningStatus } from "@services/parameters/types";
import { RotateCcwIcon, Save } from "lucide-react";
import { useFormContext } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import GeneratingConfig from "../../_components/generating-config";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import {
    type AutomationCodeReviewConfigPageProps,
    type CodeReviewFormType,
} from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { usePlatformConfig } from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { ApplyFiltersToKodyRules } from "./_components/apply-filters-to-kody-rules";
import { MinimumSeverityLevel } from "./_components/minimum-severity-level";

export default function SuggestionControl(
    props: AutomationCodeReviewConfigPageProps,
) {
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const platformConfig = usePlatformConfig();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });

    const handleSubmit = form.handleSubmit(async (formData) => {
        try {
            const saveResult = await saveSettings(formData, {
                prepare: (data) => {
                    const { language: _language, ...config } = data;
                    const unformatted = unformatConfig(config);
                    return {
                        savedFormData: data,
                        codeReviewConfig: unformatted,
                    };
                },
            });

            if (saveResult.centralizedPr) {
                toast(
                    getCentralizedPrToastPayload(
                        saveResult.centralizedPr,
                        "Change proposed through centralized pull request.",
                    ),
                );
                return;
            }

            toast({
                description: "Settings saved",
                variant: "success",
            });
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

    const {
        isDirty: formIsDirty,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = form.formState;

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Review filters" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Review filters</Page.Title>
                <hr />

                <Page.HeaderActions>
                    {formIsDirty && (
                        <Button
                            size="md"
                            variant="cancel"
                            leftIcon={<RotateCcwIcon />}
                            onClick={() => form.reset()}
                            disabled={formIsSubmitting}>
                            Reset
                        </Button>
                    )}

                    <CodeReviewSaveButton
                        size="md"
                        variant="primary"
                        leftIcon={<Save />}
                        onClick={handleSubmit}
                        disabled={!formIsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="flex-none">
                <div className="flex flex-col gap-8">
                    <div data-field-name="suggestionControl.severityLevelFilter">
                        <MinimumSeverityLevel />
                    </div>
                    <div data-field-name="suggestionControl.applyFiltersToKodyRules">
                        <ApplyFiltersToKodyRules />
                    </div>
                </div>
            </Page.Content>
        </Page.Root>
    );
}
