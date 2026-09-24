"use client";

import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { KodyLearningStatus } from "@services/parameters/types";
import { useFormContext, useFormState } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import {
    type AutomationCodeReviewConfigPageProps,
    type CodeReviewFormType,
} from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import { usePlatformConfig } from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { PrSummaryFields } from "./_components/pr-summary-fields";

export default function PRSummary(props: AutomationCodeReviewConfigPageProps) {
    const { teamId } = useSelectedTeamId();
    const platformConfig = usePlatformConfig();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const form = useFormContext<CodeReviewFormType>();
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
    } = useFormState({ control: form.control });

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.Title>PR summary</Page.Title>

                <Page.SaveActions
                    isDirty={formIsDirty}
                    isSaving={formIsSubmitting}
                    canSave={formIsValid}
                    onReset={() => form.reset()}
                    onSave={handleSubmit}
                />
            </Page.Header>

            <Page.Content className="gap-8">
                <CentralizedConfigReadOnlyAlert />
                <PrSummaryFields />
            </Page.Content>
        </Page.Root>
    );
}
