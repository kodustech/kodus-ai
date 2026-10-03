"use client";

import { Suspense, useMemo } from "react";
import { Badge } from "@components/ui/badge";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useFormContext, useFormState, useWatch } from "react-hook-form";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import {
    useDefaultCodeReviewConfig,
    useFeatureFlags,
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
import { DeterministicEvidence } from "./_components/deterministic-evidence";
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
    const deterministicEvidenceEnabled =
        useFeatureFlags().deterministicEvidence === true;
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
    const dirtyPromptField = PROMPT_FIELDS.find((fieldName, index) => {
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
    const promptsDirty = dirtyPromptField !== undefined;
    const othersDirty = Object.keys(dirtyFields ?? {}).some(
        (key) => key !== "v2PromptOverrides",
    );
    const formIsDirty = promptsDirty || othersDirty;

    // The layout's guard leaves prompt fields out (see above), so an edited
    // category instruction showed "Unsaved changes" yet let the sidebar
    // navigate away and drop it. Guard it here, as the Prompts page does.
    useUnsavedChangesGuard({
        id: "review-scope-instructions",
        isDirty: promptsDirty || formIsSubmitting,
        onBlock: () => {
            // Field names end in `.value`; the row marks its unsuffixed
            // name, so walk the prefixes like the layout does.
            const segments = dirtyPromptField?.split(".") ?? [];
            let target: Element | null = null;
            for (let i = segments.length; i > 0 && !target; i--) {
                target = document.querySelector(
                    `[data-field-name="${segments.slice(0, i).join(".")}"]`,
                );
            }
            target ??= document.querySelector("[data-header-actions]");
            if (!target) return;
            target.scrollIntoView({ behavior: "smooth", block: "center" });
            target.classList.add("field-highlight");
            window.setTimeout(
                () => target.classList.remove("field-highlight"),
                1800,
            );
        },
    });

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header sticky>
                <Page.TitleContainer>
                    <Page.Title>What to review</Page.Title>
                    <Page.Description>
                        Turn categories on or off, tell Kody what each one means
                        in your codebase, and set the severity below which
                        suggestions stay unposted.
                    </Page.Description>
                </Page.TitleContainer>

                <Page.SaveActions
                    isDirty={formIsDirty}
                    isSaving={formIsSubmitting}
                    canSave={canEdit && formIsValid}
                    onReset={() => form.reset()}
                    onSave={handleSubmit}
                />
            </Page.Header>

            <Page.Content className="gap-6">
                <CentralizedConfigReadOnlyAlert />
                <CategoryList canEdit={canEdit} defaults={defaults} />
                <SeverityCard />

                {/* The pipeline gates this feature on its own and fails
                    closed, so without the same gate here the toggles would
                    save and then quietly do nothing. */}
                {deterministicEvidenceEnabled && (
                    <div
                        className="flex flex-col gap-4"
                        data-field-name="deterministicEvidence">
                        <div className="flex flex-col gap-1">
                            <Heading variant="h2">
                                Deterministic checks <Badge>Beta</Badge>
                            </Heading>
                            <p className="text-text-secondary text-sm">
                                Scanners that answer a question of fact rather
                                than judgement, and the results your own CI
                                already produced. Everything here is off unless
                                you turn it on.
                            </p>
                        </div>

                        <DeterministicEvidence />
                    </div>
                )}
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
