"use client";

import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { toast } from "@components/ui/toaster/use-toast";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { PARAMETERS_PATHS } from "@services/parameters";
import {
    createOrUpdateCodeReviewParameter,
    createOrUpdateParameter,
    getGenerateKodusConfigFile,
} from "@services/parameters/fetch";
import {
    KodyLearningStatus,
    ParametersConfigKey,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { DownloadIcon, SaveIcon } from "lucide-react";
import { FormProvider, useFormContext } from "react-hook-form";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { AsyncBoundary } from "src/core/components/async-boundary";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import GeneratingConfig from "../../_components/generating-config";
import { FormattedConfigLevel, type CodeReviewFormType } from "../../_types";
import { usePlatformConfig } from "../../../_components/context";
import {
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "../../../_hooks";
import { AutomatedReviewActive } from "./_components/automated-review-active";
import { BaseBranches } from "./_components/base-branches";
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
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { resetQueries, generateQueryKey } = useReactQueryInvalidateQueries();
    const currentLevel = useCurrentConfigLevel();

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const handleSubmit = form.handleSubmit(async (formData) => {
        const { language, ...config } = formData;

        // Remove reviewCadence when automation is disabled
        if (!formData.automatedReviewActive) delete config.reviewCadence;

        const unformattedConfig = unformatConfig(config);

        try {
            const [languageResult, reviewResult] = await Promise.all([
                createOrUpdateParameter(
                    ParametersConfigKey.LANGUAGE_CONFIG,
                    language,
                    teamId,
                ),
                createOrUpdateCodeReviewParameter(
                    unformattedConfig,
                    teamId,
                    repositoryId,
                    directoryId,
                ),
            ]);

            if (languageResult.error || reviewResult.error) {
                throw new Error(
                    `Failed to save settings: ${[
                        languageResult.error,
                        reviewResult.error,
                    ]
                        .filter(Boolean)
                        .join(", ")}`,
                );
            }

            await Promise.all([
                resetQueries({
                    queryKey: generateQueryKey(PARAMETERS_PATHS.GET_BY_KEY, {
                        params: {
                            key: ParametersConfigKey.CODE_REVIEW_CONFIG,
                            teamId,
                        },
                    }),
                }),
                resetQueries({
                    queryKey: generateQueryKey(
                        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
                        {
                            params: {
                                teamId,
                            },
                        },
                    ),
                }),
            ]);

            form.reset({ ...config, language });

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

    const downloadFileText =
        currentLevel === FormattedConfigLevel.GLOBAL
            ? "default"
            : currentLevel === FormattedConfigLevel.REPOSITORY
              ? "repository"
              : "directory";

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="General" />
            </Page.Header>

            <Page.Header>
                <Page.Title>General settings</Page.Title>
                <Page.HeaderActions>
                    <Button
                        size="md"
                        leftIcon={<DownloadIcon />}
                        onClick={async () => await handleFileDownload()}
                        variant="secondary"
                        loading={formIsSubmitting}>
                        Download {downloadFileText} YML configuration file
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSubmit}
                        disabled={!canEdit || !formIsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </Button>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content>
                <AutomatedReviewActive />
                <KodusConfigFileOverridesWebPreferences />
                <PullRequestApprovalActive />
                <AsyncBoundary errorVariant="minimal">
                    <IsRequestChangesActive />
                </AsyncBoundary>
                <RunOnDraft />
                <ShowStatusFeedback />
                {repositoryId !== "global" && <FineTuningToggle />}
                <AsyncBoundary errorVariant="minimal">
                    <EnableCommittableSuggestions />
                </AsyncBoundary>
                <AsyncBoundary errorVariant="minimal">
                    <CrossfileDependenciesAnalysis />
                </AsyncBoundary>
                <IgnorePaths />
                <IgnoredTitleKeywords />
                <BaseBranches />

                {repositoryId === "global" && (
                    <FormProvider {...form}>
                        <LanguageSelector />
                    </FormProvider>
                )}
            </Page.Content>
        </Page.Root>
    );
}
