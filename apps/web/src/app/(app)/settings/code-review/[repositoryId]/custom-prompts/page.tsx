"use client";

import { Suspense, useCallback, useMemo } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { SaveIcon } from "lucide-react";
import { Path, useFormContext, useWatch } from "react-hook-form";
import { useMCPMentions } from "src/core/hooks/use-mcp-mentions";
import { useUnsavedChangesGuard } from "src/core/hooks/use-unsaved-changes-guard";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
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
import { PromptEditorField } from "./_components/prompt-editor-field";
import {
    getPromptFieldText,
    getValueAtPath,
    parsePromptFieldValue,
} from "./_utils/custom-prompts-state";

type PromptFieldConfig = {
    name: Path<CodeReviewFormType>;
    fieldName: string;
    label: string;
    helperText: string;
    placeholder: string;
    defaultValue: string;
};

type PromptDefaults = NonNullable<
    ReturnType<typeof useDefaultCodeReviewConfig>["v2PromptOverrides"]
>;

type PromptSectionConfig = {
    fieldName: string;
    title: string;
    description: string;
    contentClassName: string;
    fields: PromptFieldConfig[];
};

function buildPromptSections(defaults: PromptDefaults): PromptSectionConfig[] {
    return [
        {
            fieldName: "v2PromptOverrides.generation",
            title: "Suggestion Prompts",
            description: "Define how kody writes suggestions comments.",
            contentClassName: "grid grid-cols-1 gap-6",
            fields: [
                {
                    name: "v2PromptOverrides.generation.main.value",
                    fieldName: "v2PromptOverrides.generation.main",
                    label: "Base instruction",
                    helperText: "Used for all suggestions (max 2000).",
                    placeholder:
                        "Describe what Kody should analyze and suggest... Use @ to insert MCP tools for dynamic data.",
                    defaultValue: defaults.generation?.main ?? "",
                },
            ],
        },
        {
            fieldName: "v2PromptOverrides.categories",
            title: "Category Prompts",
            description: "Set the prompt Kody uses for each category.",
            contentClassName: "grid grid-cols-1 gap-6",
            fields: [
                {
                    name: "v2PromptOverrides.categories.descriptions.bug.value",
                    fieldName: "v2PromptOverrides.categories.descriptions.bug",
                    label: "Bug",
                    helperText: "Prompt for Bugs (max 2000).",
                    placeholder: "Type the prompt for Bugs",
                    defaultValue: defaults.categories?.descriptions?.bug ?? "",
                },
                {
                    name: "v2PromptOverrides.categories.descriptions.performance.value",
                    fieldName:
                        "v2PromptOverrides.categories.descriptions.performance",
                    label: "Performance",
                    helperText: "Prompt for Performance (max 2000).",
                    placeholder: "Type the prompt for Performance",
                    defaultValue:
                        defaults.categories?.descriptions?.performance ?? "",
                },
                {
                    name: "v2PromptOverrides.categories.descriptions.security.value",
                    fieldName:
                        "v2PromptOverrides.categories.descriptions.security",
                    label: "Security",
                    helperText: "Prompt for Security (max 2000).",
                    placeholder: "Type the prompt for Security",
                    defaultValue:
                        defaults.categories?.descriptions?.security ?? "",
                },
            ],
        },
    ];
}

function CustomPromptsContent() {
    const platformConfig = usePlatformConfig();
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const defaults = useDefaultCodeReviewConfig()?.v2PromptOverrides;
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
    const { mcpGroups, formatInsertByType } = useMCPMentions();

    const promptSections = useMemo(
        () => (defaults ? buildPromptSections(defaults) : []),
        [defaults],
    );
    const promptFieldConfigs = useMemo(
        () => promptSections.flatMap((section) => section.fields),
        [promptSections],
    );
    const promptFields = useMemo(
        () => promptFieldConfigs.map((field) => field.name) as string[],
        [promptFieldConfigs],
    );
    const { isValid: formIsValid, isSubmitting: formIsSubmitting } =
        form.formState;

    const watchedPromptValues = useWatch({
        control: form.control,
        name: promptFields as any[],
    });

    const dirtyFields = useMemo(
        () =>
            Object.fromEntries(
                promptFields.map((fieldName, index) => {
                    const currentVal = watchedPromptValues[index];
                    const savedVal = getValueAtPath(
                        form.formState.defaultValues ?? {},
                        fieldName,
                    );
                    const currentText = getPromptFieldText(
                        parsePromptFieldValue(currentVal),
                    );
                    const savedText = getPromptFieldText(
                        parsePromptFieldValue(savedVal),
                    );
                    return [fieldName, currentText !== savedText];
                }),
            ),
        [watchedPromptValues, promptFields],
    );
    const isPromptsDirty = useMemo(
        () => Object.values(dirtyFields).some(Boolean),
        [dirtyFields],
    );

    const handleSubmit = form.handleSubmit(async (formData) => {
        try {
            const saveResult = await saveSettings(formData, {
                prepare: (data) => {
                    const { language: _language, ...config } = data;
                    const unformatted = unformatConfig(config);
                    return {
                        savedFormData: data,
                        codeReviewConfig: {
                            v2PromptOverrides: unformatted.v2PromptOverrides,
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

    const scrollToDirtyPrompt = useCallback(() => {
        const dirtyField = promptFields.find((field) => dirtyFields[field]);

        if (dirtyField) {
            let fieldElement: Element | null = null;
            const segments = dirtyField.split(".");

            for (
                let index = segments.length;
                index > 0 && !fieldElement;
                index--
            ) {
                fieldElement = document.querySelector(
                    `[data-field-name="${segments.slice(0, index).join(".")}"]`,
                );
            }

            if (fieldElement) {
                fieldElement.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                });
                fieldElement.classList.add("field-highlight");
                window.setTimeout(() => {
                    fieldElement?.classList.remove("field-highlight");
                }, 1800);

                fieldElement
                    .querySelectorAll<HTMLElement>(
                        "[data-reset-button]:not(:disabled)",
                    )
                    .forEach((button) => {
                        button.classList.add("field-highlight");
                        window.setTimeout(() => {
                            button.classList.remove("field-highlight");
                        }, 1800);
                    });
                return;
            }
        }

        const headerElement = document.querySelector("[data-header-actions]");
        if (headerElement) {
            headerElement.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
            headerElement.classList.add("field-highlight");
            window.setTimeout(() => {
                headerElement.classList.remove("field-highlight");
            }, 1800);
        }
    }, [dirtyFields, promptFields]);

    useUnsavedChangesGuard({
        id: "custom-prompts",
        isDirty: isPromptsDirty || formIsSubmitting,
        onBlock: scrollToDirtyPrompt,
    });

    if (!defaults) {
        return null;
    }

    if (
        platformConfig.kodyLearningStatus ===
        KodyLearningStatus.GENERATING_CONFIG
    ) {
        return <GeneratingConfig />;
    }

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Custom Prompts" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Custom Prompts</Page.Title>

                <Page.HeaderActions>
                    <CodeReviewSaveButton
                        size="md"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        onClick={handleSubmit}
                        disabled={!canEdit || !isPromptsDirty || !formIsValid}
                        loading={formIsSubmitting}>
                        Save settings
                    </CodeReviewSaveButton>
                </Page.HeaderActions>
            </Page.Header>

            <Page.Content className="gap-8">
                <CentralizedConfigReadOnlyAlert />
                {promptSections.map((section) => (
                    <Card
                        key={section.fieldName}
                        data-field-name={section.fieldName}>
                        <CardHeader>
                            <CardTitle>{section.title}</CardTitle>
                            <CardDescription>
                                {section.description}
                            </CardDescription>
                        </CardHeader>

                        <CardContent>
                            <div className={section.contentClassName}>
                                {section.fields.map((field) => (
                                    <PromptEditorField
                                        key={field.name}
                                        name={field.name}
                                        fieldName={field.fieldName}
                                        label={field.label}
                                        helperText={field.helperText}
                                        placeholder={field.placeholder}
                                        defaultValue={field.defaultValue}
                                        canEdit={canEdit}
                                        groups={mcpGroups}
                                        formatInsertByType={formatInsertByType}
                                    />
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                ))}
            </Page.Content>
        </Page.Root>
    );
}

export default function CustomPrompts() {
    return (
        <Suspense
            fallback={
                <div className="flex h-full w-full items-center justify-center py-10">
                    <Spinner className="size-6" />
                </div>
            }>
            <CustomPromptsContent />
        </Suspense>
    );
}
