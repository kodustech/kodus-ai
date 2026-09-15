"use client";

import { Suspense, useMemo } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { RotateCcwIcon, SaveIcon } from "lucide-react";
import { useFormContext, useFormState, useWatch } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import {
    useDefaultCodeReviewConfig,
    usePlatformConfig,
} from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import {
    getPromptFieldText,
    getValueAtPath,
    parsePromptFieldValue,
} from "../custom-prompts/_utils/custom-prompts-state";
import {
    filterVisibleReviewLabels,
    mergeMissingReviewOptions,
} from "../general/_utils/review-options-state";
import { CategoryList } from "./_components/category-list";
import { SeverityCard } from "./_components/severity-card";

const PROMPT_FIELDS = [
    "v2PromptOverrides.categories.descriptions.bug.value",
    "v2PromptOverrides.categories.descriptions.performance.value",
    "v2PromptOverrides.categories.descriptions.security.value",
] as const;

function ReviewScopeContent() {
    const platformConfig = usePlatformConfig();
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { data: labels = [] } = useGetCodeReviewLabels("v2");
    const defaults = useDefaultCodeReviewConfig()?.v2PromptOverrides;
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );
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

    // Categories, their instructions and the severity threshold all live in
    // the same form, so one submit saves the whole screen.
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

    const {
        dirtyFields,
        defaultValues: formDefaultValues,
        isValid: formIsValid,
        isSubmitting: formIsSubmitting,
    } = useFormState({ control: form.control });

    // The prompt editor writes its default text into the form on mount, so
    // react-hook-form flags the prompt fields dirty as soon as a row opens.
    // Compare the text instead (same trick as the Prompts page) and only
    // trust `dirtyFields` for everything else.
    const promptValues = useWatch({
        control: form.control,
        name: PROMPT_FIELDS as never,
    }) as unknown[];
    const promptsDirty = PROMPT_FIELDS.some((fieldName, index) => {
        const current = getPromptFieldText(
            parsePromptFieldValue(promptValues?.[index]),
        );
        const saved = getPromptFieldText(
            parsePromptFieldValue(
                getValueAtPath(formDefaultValues ?? {}, fieldName),
            ),
        );
        return current !== saved;
    });
    const othersDirty = Object.keys(dirtyFields ?? {}).some(
        (key) => key !== "v2PromptOverrides",
    );
    const formIsDirty = promptsDirty || othersDirty;

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>What to review</Page.Title>
                    <Page.Description>
                        Turn categories on or off, tell Kody what each one means
                        in your codebase, and set the severity below which
                        suggestions stay unposted.
                    </Page.Description>
                </Page.TitleContainer>

                <Page.HeaderActions>
                    {formIsDirty && (
                        <Button
                            size="sm"
                            variant="cancel"
                            leftIcon={<RotateCcwIcon />}
                            onClick={() => form.reset()}
                            disabled={formIsSubmitting}>
                            Reset
                        </Button>
                    )}
                    <CodeReviewSaveButton
                        size="sm"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSubmit}
                        disabled={!canEdit || !formIsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />
                <CategoryList canEdit={canEdit} defaults={defaults} />
                <SeverityCard />
            </Page.Content>
        </Page.Root>
    );
}

export default function ReviewScope() {
    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center py-10">
                    <Spinner className="size-6" />
                </div>
            }>
            <ReviewScopeContent />
        </Suspense>
    );
}
