"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { KodyLearningStatus } from "@services/parameters/types";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { useFormContext } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { usePlatformConfig } from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { AnalysisTypes } from "../general/_components/analysis-types";
import {
    filterVisibleReviewLabels,
    mergeMissingReviewOptions,
} from "../general/_utils/review-options-state";

export default function ReviewCategories() {
    const platformConfig = usePlatformConfig();
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { data: labels = [] } = useGetCodeReviewLabels("v2");
    const { saveSettings } = useCodeReviewSettingsMutation({
        teamId,
        repositoryId,
        directoryId,
        form,
    });
    const visibleLabelTypes = useMemo(
        () =>
            filterVisibleReviewLabels(labels, true).map((label) => label.type),
        [labels],
    );

    const handleSubmit = form.handleSubmit(async (formData) => {
        try {
            const mergedFormData = {
                ...formData,
                reviewOptions: mergeMissingReviewOptions(
                    formData.reviewOptions || {},
                    visibleLabelTypes,
                ),
            };
            const saveResult = await saveSettings(mergedFormData, {
                prepare: (data) => {
                    const { language: _language, ...config } = data;
                    const unformatted = unformatConfig(config);
                    return {
                        savedFormData: data,
                        codeReviewConfig: {
                            ...unformatted,
                            reviewOptions: unformatted.reviewOptions,
                        },
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
                <CodeReviewPagesBreadcrumb pageName="Review Categories" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Review Categories</Page.Title>

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
                        leftIcon={<SaveIcon />}
                        onClick={handleSubmit}
                        disabled={!formIsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />
                <div data-field-name="analysisTypes">
                    <AnalysisTypes />
                </div>
            </Page.Content>
        </Page.Root>
    );
}
