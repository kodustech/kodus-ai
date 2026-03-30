"use client";

import { useState } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import {
    createOrUpdateParameter,
    getGenerateKodusConfigFile,
} from "@services/parameters/fetch";
import { useOptionalParameterQuery } from "@services/parameters/hooks";
import {
    KodyLearningStatus,
    ParametersConfigKey,
    type CentralizedConfigValue,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    DownloadIcon,
    RotateCcwIcon,
    SaveIcon,
    Settings2Icon,
} from "lucide-react";
import { FormProvider, useFormContext } from "react-hook-form";
import { AsyncBoundary } from "src/core/components/async-boundary";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../_components/centralized-config-readonly-alert";
import GeneratingConfig from "../../_components/generating-config";
import { CodeReviewSaveButton } from "../../_components/save-button";
import { useCodeReviewSettingsMutation } from "../../_hooks/use-code-review-settings-mutation";
import { FormattedConfigLevel, type CodeReviewFormType } from "../../_types";
import {
    useFeatureFlags,
    usePlatformConfig,
} from "../../../_components/context";
import {
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "../../../_hooks";
import { AutomatedReviewActive } from "./_components/automated-review-active";
import { BaseBranches } from "./_components/base-branches";
import { CentralizedConfigModal } from "./_components/centralized-config-modal";
import { CrossfileDependenciesAnalysis } from "./_components/crossfile-dependencies-analysis";
import { EnableCommittableSuggestions } from "./_components/enable-committable-suggestions";
import { FineTuningToggle } from "./_components/fine-tuning-toggle";
import { IgnorePaths } from "./_components/ignore-paths";
import { IgnoredTitleKeywords } from "./_components/ignored-title-keywords";
import { IsRequestChangesActive } from "./_components/is-request-changes-active";
import { KodusConfigFileOverridesWebPreferences } from "./_components/kodus-config-file-overrides-web-preferences";
import { LanguageSelector } from "./_components/language-selector";
import { PullRequestApprovalActive } from "./_components/pull-request-approval-active";
import { RunOnDraft } from "./_components/run-on-draft";
import { ShowStatusFeedback } from "./_components/show-status-feedback";

export default function General() {
    const platformConfig = usePlatformConfig();
    const { centralizedConfigParameter } = useFeatureFlags();
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

    const isCentralizedConfigEnabled =
        centralizedConfigParameter === true &&
        centralizedConfig.data?.configValue?.enabled === true;
    const isGlobalGeneralView =
        repositoryId === "global" &&
        currentLevel === FormattedConfigLevel.GLOBAL;
    const isCentralizedReadOnly = isCentralizedConfigEnabled;

    const downloadFileText =
        currentLevel === FormattedConfigLevel.GLOBAL
            ? "default"
            : currentLevel === FormattedConfigLevel.REPOSITORY
                ? "repository"
                : "directory";

    const handleFileDownload = async () => {
        try {
            const downloadFile = await getGenerateKodusConfigFile(
                teamId,
                repositoryId,
                directoryId,
            );

            const blob = new Blob([downloadFile], { type: "text/yaml" });
            const url = window.URL.createObjectURL(blob);

            const a = document.createElement("a");
            a.href = url;
            a.download = "kodus-config.yml";

            document.body.appendChild(a);
            a.click();

            a.remove();
            window.URL.revokeObjectURL(url);

            toast({
                description: "File downloaded",
                variant: "success",
            });
        } catch (error) {
            console.error("Error saving settings:", error);

            toast({
                title: "Error",
                description:
                    "An error occurred while generating the yml file. Please try again.",
                variant: "danger",
            });
        }
    };

    const handleSubmit = form.handleSubmit(async (formData) => {
        const { language, ...config } = formData;

        // Remove reviewCadence when automation is disabled
        if (!formData.automatedReviewActive) delete config.reviewCadence;

        const unformattedConfig = unformatConfig(config);

        try {
            await saveSettings(formData, {
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
                <CodeReviewPagesBreadcrumb pageName="General" />
            </Page.Header>

            <Page.Header>
                <Page.Title>General settings</Page.Title>
                <Page.HeaderActions>
                    {centralizedConfigParameter && isGlobalGeneralView && (
                        <Button
                            size="md"
                            leftIcon={<Settings2Icon />}
                            onClick={() => setIsCentralizedModalOpen(true)}
                            variant="secondary"
                            disabled={!canEdit}>
                            Configure centralized config
                        </Button>
                    )}

                    {!centralizedConfigParameter && (
                        <Button
                            size="md"
                            leftIcon={<DownloadIcon />}
                            onClick={async () => await handleFileDownload()}
                            variant="secondary"
                            loading={formIsSubmitting}>
                            Download {downloadFileText} YML configuration file
                        </Button>
                    )}

                    {formIsDirty && !isCentralizedReadOnly && (
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
                        disabled={
                            !canEdit ||
                            !formIsDirty ||
                            !formIsValid ||
                            isCentralizedReadOnly
                        }
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />

                <fieldset disabled={isCentralizedReadOnly} className="contents">
                    <div data-field-name="automatedReviewActive">
                        <AutomatedReviewActive />
                    </div>
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
                    {repositoryId === "global" && (
                        <div data-field-name="kodyFineTuningEnabled">
                            <FineTuningToggle />
                        </div>
                    )}
                    {repositoryId !== "global" && <FineTuningToggle />}
                    <AsyncBoundary errorVariant="minimal">
                        <div data-field-name="enableCommittableSuggestions">
                            <EnableCommittableSuggestions />
                        </div>
                    </AsyncBoundary>
                    <AsyncBoundary errorVariant="minimal">
                        <div data-field-name="crossFileDependenciesAnalysis">
                            <CrossfileDependenciesAnalysis />
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
                </fieldset>

                {centralizedConfigParameter && isGlobalGeneralView && (
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
