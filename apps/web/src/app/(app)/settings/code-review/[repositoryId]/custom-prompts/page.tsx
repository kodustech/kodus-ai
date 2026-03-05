"use client";

import React, { Suspense, useEffect, useRef, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { FormControl } from "@components/ui/form-control";
import { Page } from "@components/ui/page";
import { getTextStatsFromTiptapJSON } from "@components/ui/rich-text-editor";
import { RichTextEditorWithMentions } from "@components/ui/rich-text-editor-with-mentions";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { PARAMETERS_PATHS } from "@services/parameters";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { CodeReviewV2Defaults } from "@services/parameters/hooks";
import {
    KodyLearningStatus,
    ParametersConfigKey,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { SaveIcon } from "lucide-react";
import { Controller, Path, useFormContext } from "react-hook-form";
import { useMCPMentions } from "src/core/hooks/use-mcp-mentions";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { unformatConfig } from "src/core/utils/helpers";
import { convertTiptapJSONToText } from "src/core/utils/tiptap-json-to-text";

import { CodeReviewPagesBreadcrumb } from "../../_components/breadcrumb";
import GeneratingConfig from "../../_components/generating-config";
import { OverrideIndicatorForm } from "../../_components/override";
import { type CodeReviewFormType } from "../../_types";
import {
    useDefaultCodeReviewConfig,
    usePlatformConfig,
} from "../../../_components/context";
import { useCodeReviewRouteParams } from "../../../_hooks";
import { ExternalReferencesDisplay } from "../pr-summary/_components/external-references-display";

// Use the exported utility function from rich-text-editor
function getTextFromValue(value: string | object | null | undefined): string {
    return convertTiptapJSONToText(value);
}

function parseFieldValue(value: any): string | object {
    if (
        typeof value === "string" &&
        value.startsWith("{") &&
        value.trim().startsWith("{")
    ) {
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    }
    if (typeof value === "object" && value !== null) {
        return value;
    }
    return value ?? "";
}

function serializeFieldValue(value: string | object): string {
    if (typeof value === "object" && value !== null) {
        return JSON.stringify(value);
    }
    return value || "";
}

function CustomPromptsContent() {
    const platformConfig = usePlatformConfig();
    const form = useFormContext<CodeReviewFormType>();
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { resetQueries, generateQueryKey } = useReactQueryInvalidateQueries();
    const defaults = useDefaultCodeReviewConfig()?.v2PromptOverrides;
    const initialized = useRef(false);

    if (!defaults) {
        return null;
    }

    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
        repositoryId,
    );

    const { mcpGroups, formatInsertByType } = useMCPMentions();

    const handleSubmit = form.handleSubmit(async (formData) => {
        try {
            const unformattedConfig = unformatConfig(formData);

            const result = await createOrUpdateCodeReviewParameter(
                unformattedConfig,
                teamId,
                repositoryId,
                directoryId,
            );

            if (result.error) {
                throw new Error(`Failed to save settings: ${result.error}`);
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

            form.reset(formData);

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

    // Prefill with defaults only once if fields are empty (no value saved)
    useEffect(() => {
        if (initialized.current) return;
        if (!defaults) return;

        const current = form.getValues();

        const map: Array<[Path<CodeReviewFormType>, string | undefined]> = [
            [
                "v2PromptOverrides.categories.descriptions.bug.value",
                defaults.categories?.descriptions?.bug,
            ],
            [
                "v2PromptOverrides.categories.descriptions.performance.value",
                defaults.categories?.descriptions?.performance,
            ],
            [
                "v2PromptOverrides.categories.descriptions.security.value",
                defaults.categories?.descriptions?.security,
            ],
            [
                "v2PromptOverrides.severity.flags.critical.value",
                defaults.severity?.flags?.critical,
            ],
            [
                "v2PromptOverrides.severity.flags.high.value",
                defaults.severity?.flags?.high,
            ],
            [
                "v2PromptOverrides.severity.flags.medium.value",
                defaults.severity?.flags?.medium,
            ],
            [
                "v2PromptOverrides.severity.flags.low.value",
                defaults.severity?.flags?.low,
            ],
            [
                "v2PromptOverrides.generation.main.value",
                defaults.generation?.main,
            ],
        ];

        let changed = false;
        map.forEach(([path, value]) => {
            const currentValue = (current as any)?.v2PromptOverrides
                ? path.split(".").reduce<any>((acc, key) => acc?.[key], current)
                : undefined;

            const currentText =
                typeof currentValue === "object" && currentValue !== null
                    ? getTextFromValue(currentValue)
                    : String(currentValue || "");
            if (!currentValue || currentText.trim() === "") {
                form.setValue(path, value ?? "", { shouldDirty: false });
                changed = true;
            }
        });

        if (changed) initialized.current = true;
    }, [defaults]);
    // Field-level helpers will compare and reset individually

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Custom Prompts" />
            </Page.Header>

            <Page.Header>
                <Page.Title>Custom Prompts</Page.Title>

                <Page.HeaderActions>
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

            <Page.Content className="gap-8">
                <Card>
                    <CardHeader>
                        <CardTitle>Suggestion Prompts</CardTitle>
                        <CardDescription>
                            Define how kody writes suggestions comments.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 gap-6">
                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.generation.main.value">
                                            Base instruction
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.generation.main" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.generation.main.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.generation?.main ??
                                                "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Used for all suggestions (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.generation.main.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        // If it's a JSON string, parse to object
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        // Se já é objeto, usa direto
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        // Convert Tiptap JSON object to JSON string for saving
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Describe what Kody should analyze and suggest... Use @ to insert MCP tools for dynamic data."
                                                    className="min-h-32"
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.generation.main",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Category Prompts</CardTitle>
                        <CardDescription>
                            Set the prompt Kody uses for each category.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 gap-6">
                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.categories.descriptions.bug.value">
                                            Bug
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.categories.descriptions.bug" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.categories.descriptions.bug.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.categories
                                                    ?.descriptions?.bug ?? "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for Bugs (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.categories.descriptions.bug.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for Bugs"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.categories.descriptions.bug",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>

                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.categories.descriptions.performance.value">
                                            Performance
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.categories.descriptions.performance" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.categories.descriptions.performance.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.categories
                                                    ?.descriptions
                                                    ?.performance ?? "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for Performance (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.categories.descriptions.performance.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for Performance"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.categories.descriptions.performance",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>

                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.categories.descriptions.security.value">
                                            Security
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.categories.descriptions.security" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.categories.descriptions.security.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.categories
                                                    ?.descriptions?.security ??
                                                "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for Security (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.categories.descriptions.security.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for Security"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.categories.descriptions.security",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Severity Prompts</CardTitle>
                        <CardDescription>
                            Define how Kody classifies each severity level.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.severity.flags.critical.value">
                                            Critical
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.severity.flags.critical" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.critical.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.severity?.flags
                                                    ?.critical ?? "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for Critical (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.critical.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for Critical"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.severity.flags.critical",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>

                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.severity.flags.high.value">
                                            High
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.severity.flags.high" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.high.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.severity?.flags
                                                    ?.high ?? "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for High (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.high.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for High"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.severity.flags.high",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>

                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.severity.flags.medium.value">
                                            Medium
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.severity.flags.medium" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.medium.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.severity?.flags
                                                    ?.medium ?? "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for Medium (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.medium.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for Medium"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.severity.flags.medium",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>

                            <FormControl.Root>
                                <div className="flex items-center justify-between gap-3">
                                    <div className="mb-2 flex flex-row items-center gap-2">
                                        <FormControl.Label
                                            className="mb-0"
                                            htmlFor="v2PromptOverrides.severity.flags.low.value">
                                            Low
                                        </FormControl.Label>
                                        <OverrideIndicatorForm fieldName="v2PromptOverrides.severity.flags.low" />
                                    </div>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.low.value"
                                        control={form.control}
                                        render={({ field }) => {
                                            const def =
                                                defaults?.severity?.flags
                                                    ?.low ?? "";
                                            const fieldText = getTextFromValue(
                                                field.value,
                                            );
                                            const isDefault =
                                                fieldText.trim() === def.trim();
                                            return (
                                                <div className="flex items-center gap-2">
                                                    <Badge
                                                        variant="secondary"
                                                        className="h-6 min-h-auto px-2.5">
                                                        {isDefault
                                                            ? "Default"
                                                            : "Custom"}
                                                    </Badge>
                                                    <Button
                                                        size="sm"
                                                        variant="helper"
                                                        onClick={() =>
                                                            field.onChange(def)
                                                        }
                                                        disabled={
                                                            !canEdit ||
                                                            isDefault
                                                        }>
                                                        Reset to default
                                                    </Button>
                                                </div>
                                            );
                                        }}
                                    />
                                </div>
                                <FormControl.Helper className="mb-3">
                                    Prompt for Low (max 2000).
                                </FormControl.Helper>
                                <FormControl.Input>
                                    <Controller
                                        name="v2PromptOverrides.severity.flags.low.value"
                                        control={form.control}
                                        render={({ field }) => (
                                            <div>
                                                <RichTextEditorWithMentions
                                                    value={(() => {
                                                        const val = field.value;
                                                        if (
                                                            typeof val ===
                                                                "string" &&
                                                            val.startsWith("{")
                                                        ) {
                                                            try {
                                                                return JSON.parse(
                                                                    val,
                                                                );
                                                            } catch {
                                                                return val;
                                                            }
                                                        }
                                                        if (
                                                            typeof val ===
                                                                "object" &&
                                                            val !== null
                                                        ) {
                                                            return val;
                                                        }
                                                        return val ?? "";
                                                    })()}
                                                    onChangeAction={(
                                                        value: string | object,
                                                    ) => {
                                                        const toSave =
                                                            typeof value ===
                                                                "object" &&
                                                            value !== null
                                                                ? JSON.stringify(
                                                                      value,
                                                                  )
                                                                : typeof value ===
                                                                    "string"
                                                                  ? value
                                                                  : "";
                                                        field.onChange(toSave);
                                                    }}
                                                    placeholder="Type the prompt for Low"
                                                    className="min-h-32"
                                                    disabled={field.disabled}
                                                    groups={mcpGroups}
                                                    formatInsertByType={
                                                        formatInsertByType
                                                    }
                                                />
                                                <FormControl.Helper className="text-text-secondary mt-2 block text-right text-xs">
                                                    {(() => {
                                                        const stats =
                                                            typeof field.value ===
                                                                "object" &&
                                                            field.value !== null
                                                                ? getTextStatsFromTiptapJSON(
                                                                      field.value,
                                                                  )
                                                                : {
                                                                      characters:
                                                                          field
                                                                              .value
                                                                              ?.length ||
                                                                          0,
                                                                      words: 0,
                                                                      mentions: 0,
                                                                  };
                                                        return (
                                                            <>
                                                                <span className="font-medium">
                                                                    {
                                                                        stats.characters
                                                                    }
                                                                </span>{" "}
                                                                chars
                                                                {stats.words >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.words
                                                                            }
                                                                        </span>{" "}
                                                                        words
                                                                    </>
                                                                )}
                                                                {stats.mentions >
                                                                    0 && (
                                                                    <>
                                                                        {" "}
                                                                        ·{" "}
                                                                        <span className="font-medium">
                                                                            {
                                                                                stats.mentions
                                                                            }
                                                                        </span>{" "}
                                                                        mentions
                                                                    </>
                                                                )}
                                                                {" / 2000"}
                                                            </>
                                                        );
                                                    })()}
                                                </FormControl.Helper>
                                                <ExternalReferencesDisplay
                                                    externalReferences={
                                                        (
                                                            form.getValues(
                                                                "v2PromptOverrides.severity.flags.low",
                                                            ) as any
                                                        )?.externalReferences
                                                    }
                                                    compact
                                                />
                                            </div>
                                        )}
                                    />
                                </FormControl.Input>
                            </FormControl.Root>
                        </div>
                    </CardContent>
                </Card>
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
