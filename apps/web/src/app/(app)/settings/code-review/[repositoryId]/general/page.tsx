"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { createOrUpdateParameter } from "@services/parameters/fetch";
import { useOptionalParameterQuery } from "@services/parameters/hooks";
import {
    KodyLearningStatus,
    ParametersConfigKey,
    type CentralizedConfigValue,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { RotateCcwIcon, SaveIcon, Settings2Icon } from "lucide-react";
import { FormProvider, useFormContext, useFormState } from "react-hook-form";
import { AsyncBoundary } from "src/core/components/async-boundary";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { FormattedConfigLevel, type CodeReviewFormType } from "../../_types";
import { getCentralizedPrToastPayload } from "../../_utils/centralized-pr-feedback";
import {
    useCodeReviewModelData,
    usePlatformConfig,
} from "../../../_components/context";
import {
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "../../../_hooks";
import { AutomatedReviewActive } from "./_components/automated-review-active";
import { BaseBranches } from "./_components/base-branches";
import { BYOKModelSelectorSection } from "./_components/byok-model-selector";
import { CentralizedConfigModal } from "./_components/centralized-config-modal";
import { EnableCommittableSuggestions } from "./_components/enable-committable-suggestions";
import { IgnorePaths } from "./_components/ignore-paths";
import { IgnoredTitleKeywords } from "./_components/ignored-title-keywords";
import { IsRequestChangesActive } from "./_components/is-request-changes-active";
import { KodusConfigFileOverridesWebPreferences } from "./_components/kodus-config-file-overrides-web-preferences";
import { LanguageSelector } from "./_components/language-selector";
import { PullRequestApprovalActive } from "./_components/pull-request-approval-active";
import { RunOnDraft } from "./_components/run-on-draft";
import { ShowStatusFeedback } from "./_components/show-status-feedback";

/**
 * Speed-bump before saving a `byokModel` override that isn't in the provider's
 * known-models list — we can't verify it, and a wrong id makes reviews fail (or
 * fall back). Preserves the escape hatch for legit custom/proxy model ids.
 */
const confirmOffCatalogModelSave = (model: string): Promise<boolean> =>
    new Promise((resolve) => {
        magicModal.show(() => (
            <ConfirmModal
                open
                title="Save an unverified model id?"
                description={`"${model}" isn't in your BYOK provider's model list, so we can't verify it. If the id is wrong, reviews on this scope will fail (or fall back to your BYOK fallback model). Tip: use "Test model" to check it against your provider first.`}
                confirmText="Save anyway"
                cancelText="Go back"
                variant="primary-dark"
                onConfirm={() => {
                    resolve(true);
                    magicModal.hide();
                }}
                onCancel={() => {
                    resolve(false);
                    magicModal.hide();
                }}
            />
        ));
    });

export default function General() {
    const platformConfig = usePlatformConfig();
    const { byokModels } = useCodeReviewModelData();
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const currentLevel = useCurrentConfigLevel();
    const [isCentralizedModalOpen, setIsCentralizedModalOpen] = useState(false);
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

    const centralizedConfig = useOptionalParameterQuery<CentralizedConfigValue>(
        ParametersConfigKey.CENTRALIZED_CONFIG,
        teamId,
        {
            uuid: "",
            configKey: ParametersConfigKey.CENTRALIZED_CONFIG,
            configValue: {
                enabled: false,
                repository: {
                    id: "",
                    name: "",
                },
            },
        },
    );

    const isGlobalGeneralView =
        repositoryId === "global" &&
        currentLevel === FormattedConfigLevel.GLOBAL;

    const handleSubmit = form.handleSubmit(async (formData) => {
        // Gate an off-catalog byokModel override behind an explicit confirm so
        // a mistyped id can't be saved by skimming past the warning. Only when
        // we HAVE a catalog to judge against — an unlistable provider (empty
        // catalog) is left to the "Test model" check, no false prompts.
        const byokModelValue = (formData.byokModel?.value ?? "").trim();
        const isOffCatalog =
            byokModelValue.length > 0 &&
            byokModels.length > 0 &&
            !byokModels.some((m) => m.id === byokModelValue);
        if (isOffCatalog) {
            const confirmed = await confirmOffCatalogModelSave(byokModelValue);
            if (!confirmed) return;
        }

        const { language, ...config } = formData;

        // Remove reviewCadence when automation is disabled
        if (!formData.automatedReviewActive) delete config.reviewCadence;

        const unformattedConfig = unformatConfig(config);

        try {
            const saveResult = await saveSettings(formData, {
                prepare: async () => {
                    const languageResult = await createOrUpdateParameter(
                        ParametersConfigKey.LANGUAGE_CONFIG,
                        language,
                        teamId,
                    );

                    if (languageResult.error) {
                        throw new Error(
                            `Failed to save settings: ${languageResult.error}`,
                        );
                    }

                    return {
                        savedFormData: { ...config, language },
                        codeReviewConfig: unformattedConfig,
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
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="General" />
            </Page.Header>

            <Page.Header>
                <Page.Title>General settings</Page.Title>
                <Page.HeaderActions>
                    {isGlobalGeneralView && (
                        <Button
                            size="md"
                            leftIcon={<Settings2Icon />}
                            onClick={() => setIsCentralizedModalOpen(true)}
                            variant="secondary"
                            disabled={!canEdit}>
                            Configure centralized config
                        </Button>
                    )}

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
                        disabled={!canEdit || !formIsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />

                <div data-field-name="automatedReviewActive">
                    <AutomatedReviewActive />
                </div>

                {repositoryId !== "global" && (
                    <div data-field-name="byokModel">
                        <BYOKModelSelectorSection />
                    </div>
                )}

                <div data-field-name="kodusConfigFileOverridesWebPreferences">
                    <KodusConfigFileOverridesWebPreferences />
                </div>
                <div data-field-name="pullRequestApprovalActive">
                    <PullRequestApprovalActive />
                </div>
                <AsyncBoundary errorVariant="minimal">
                    <div data-field-name="isRequestChangesActive">
                        <IsRequestChangesActive />
                    </div>
                </AsyncBoundary>
                <div data-field-name="runOnDraft">
                    <RunOnDraft />
                </div>
                <div data-field-name="showStatusFeedback">
                    <ShowStatusFeedback />
                </div>
                <AsyncBoundary errorVariant="minimal">
                    <div data-field-name="enableCommittableSuggestions">
                        <EnableCommittableSuggestions />
                    </div>
                </AsyncBoundary>
                <div data-field-name="ignorePaths">
                    <IgnorePaths />
                </div>
                <div data-field-name="ignoredTitleKeywords">
                    <IgnoredTitleKeywords />
                </div>
                <div data-field-name="baseBranches">
                    <BaseBranches />
                </div>
                {repositoryId === "global" && (
                    <div data-field-name="language">
                        <FormProvider {...form}>
                            <LanguageSelector />
                        </FormProvider>
                    </div>
                )}

                {isGlobalGeneralView && (
                    <CentralizedConfigModal
                        open={isCentralizedModalOpen}
                        onOpenChange={setIsCentralizedModalOpen}
                        teamId={teamId}
                        centralizedConfig={
                            centralizedConfig.data?.configValue ?? {
                                enabled: false,
                                repository: {
                                    id: "",
                                    name: "",
                                },
                            }
                        }
                        onSaved={async () => {
                            await centralizedConfig.refetch();
                        }}
                    />
                )}
            </Page.Content>
        </Page.Root>
    );
}
