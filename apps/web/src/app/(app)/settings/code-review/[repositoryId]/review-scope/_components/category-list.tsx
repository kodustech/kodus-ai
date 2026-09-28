"use client";

import { useMemo } from "react";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Switch } from "@components/ui/switch";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCPServiceUnavailableError } from "@services/mcp-manager/utils";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { useQuery } from "@tanstack/react-query";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";
import { cn } from "src/core/utils/components";

import { OverrideIndicatorForm } from "../../../_components/override";
import { type CodeReviewFormType } from "../../../_types";
import { useDefaultCodeReviewConfig } from "../../../../_components/context";
import { PromptEditorField } from "../../custom-prompts/_components/prompt-editor-field";
import {
    getPromptFieldText,
    parsePromptFieldValue,
} from "../../custom-prompts/_utils/custom-prompts-state";
import { hasTaskManagementConnection } from "../../general/_components/analysis-types";
import {
    filterVisibleReviewLabels,
    mergeMissingReviewOptions,
} from "../../general/_utils/review-options-state";

// Categories that carry their own instructions (the prompt override keys).
const PROMPT_CATEGORIES = ["bug", "performance", "security"] as const;
type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

const promptCategoryOf = (type: string): PromptCategory | undefined =>
    (PROMPT_CATEGORIES as readonly string[]).includes(type)
        ? (type as PromptCategory)
        : undefined;

type PromptDefaults = NonNullable<
    ReturnType<typeof useDefaultCodeReviewConfig>["v2PromptOverrides"]
>;

/** "Kody's default" vs "Custom" for one category's instructions. */
const InstructionsChip = ({
    fieldName,
    defaultValue,
}: {
    fieldName: string;
    defaultValue: string;
}) => {
    const form = useFormContext<CodeReviewFormType>();
    const value = useWatch({
        control: form.control,
        name: `${fieldName}.value` as never,
    });
    const text = getPromptFieldText(parsePromptFieldValue(value)).trim();
    const isCustom = text !== "" && text !== defaultValue.trim();

    return (
        <span
            className={cn(
                "inline-flex h-5 items-center rounded px-1.5 text-xs font-medium",
                isCustom
                    ? "bg-secondary-dark text-secondary-light"
                    : "bg-card-lv2 text-text-secondary",
            )}>
            {isCustom ? "Custom" : "Kody's default"}
        </span>
    );
};

const CategoryRow = ({
    type,
    name,
    description,
    enabled,
    disabled,
    onToggle,
    showMcpWarning,
    promptDefault,
    canEdit,
}: {
    type: string;
    name: string;
    description: string;
    enabled: boolean;
    disabled?: boolean;
    onToggle: (enabled: boolean) => void;
    showMcpWarning: boolean;
    promptDefault?: string;
    canEdit: boolean;
}) => {
    const promptKey = promptCategoryOf(type);
    const fieldName = promptKey
        ? `v2PromptOverrides.categories.descriptions.${promptKey}`
        : null;
    const switchId = `category-${type}`;

    return (
        <Collapsible
            className={cn("group/collapsible", !enabled && "opacity-70")}>
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3">
                <Switch
                    id={switchId}
                    size="sm"
                    className="mt-0.5"
                    checked={enabled}
                    disabled={disabled}
                    onCheckedChange={onToggle}
                />
                <div className="flex min-w-[10rem] flex-1 flex-col gap-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                        <label
                            htmlFor={switchId}
                            className="text-text-primary cursor-pointer text-sm font-medium">
                            {name}
                        </label>
                        <OverrideIndicatorForm
                            fieldName={`reviewOptions.${type}`}
                        />
                        {showMcpWarning && (
                            <span className="bg-warning/10 text-warning inline-flex h-5 items-center rounded px-1.5 text-xs font-medium">
                                Needs a task management plugin
                            </span>
                        )}
                    </div>
                    <p className="text-text-secondary text-xs">{description}</p>
                </div>

                {/* Instructions live on the row they belong to. Hidden while
                    the category is off: nothing to instruct. */}
                {fieldName && enabled && (
                    <CollapsibleTrigger asChild>
                        <button
                            type="button"
                            className="text-text-secondary hover:text-text-primary ml-auto flex shrink-0 items-center gap-2 self-center text-xs">
                            Instructions
                            <InstructionsChip
                                fieldName={fieldName}
                                defaultValue={promptDefault ?? ""}
                            />
                            <CollapsibleIndicator />
                        </button>
                    </CollapsibleTrigger>
                )}
            </div>

            {fieldName && enabled && (
                <CollapsibleContent className="pb-0">
                    <div
                        className="border-card-lv3/60 border-t py-4 pr-4 pl-14"
                        data-field-name={fieldName}>
                        <PromptEditorField
                            name={`${fieldName}.value` as never}
                            fieldName={fieldName}
                            label={`What counts as a ${name.toLowerCase()} issue`}
                            helperText="Showing Kody's default until you change it. Clear the text to go back to it (max 2000)."
                            placeholder={`Describe what Kody should flag as ${name.toLowerCase()}…`}
                            defaultValue={promptDefault ?? ""}
                            canEdit={canEdit}
                            groups={[]}
                            formatInsertByType={{}}
                        />
                    </div>
                </CollapsibleContent>
            )}
        </Collapsible>
    );
};

/**
 * One row per category: the on/off switch, what it means, and its
 * instructions folded under the same row — so "which categories" and "what
 * each one looks for" are never two screens apart.
 */
export const CategoryList = ({
    canEdit,
    defaults,
}: {
    canEdit: boolean;
    defaults?: PromptDefaults;
}) => {
    const currentLevel = useCurrentConfigLevel();
    const form = useFormContext<CodeReviewFormType>();
    const reviewOptions = useWatch({
        control: form.control,
        name: "reviewOptions",
    });
    const businessLogicEnabled = Boolean(
        (reviewOptions as Record<string, { value?: boolean }> | undefined)
            ?.business_logic?.value,
    );
    const { data: labels = [], isLoading } = useGetCodeReviewLabels("v2");

    // Same gating as the General page: only look up MCP plugins when the
    // business-logic category is on, since that is the only row it affects.
    const { data: mcpPlugins, isFetched: isMCPFetched } = useQuery({
        queryKey: ["mcp-plugins-task-management"],
        enabled: businessLogicEnabled,
        staleTime: 5 * 60 * 1000,
        retry: false,
        queryFn: async () => {
            try {
                return await getMCPPlugins();
            } catch (error) {
                if (error instanceof MCPServiceUnavailableError) return null;
                return null;
            }
        },
    });
    const hasTaskMcp = useMemo(() => {
        if (!mcpPlugins) return false;
        return hasTaskManagementConnection(
            mcpPlugins.filter((plugin) => plugin.isConnected),
        );
    }, [mcpPlugins]);

    const visibleLabels = useMemo(
        () => filterVisibleReviewLabels(labels, true),
        [labels],
    );
    const visibleLabelTypes = useMemo(
        () => visibleLabels.map((label) => label.type),
        [visibleLabels],
    );

    if (isLoading) {
        return (
            <div className="text-text-secondary py-8 text-center text-sm">
                Loading categories…
            </div>
        );
    }

    return (
        <Controller
            name="reviewOptions"
            control={form.control}
            render={({ field }) => {
                const normalized = mergeMissingReviewOptions(
                    (field.value || reviewOptions || {}) as Record<
                        string,
                        { value: boolean; level: typeof currentLevel }
                    >,
                    visibleLabelTypes,
                );
                // Mirrors the General page: every visible option is stamped
                // with the current level on change, so override counting
                // behaves the same in both places.
                const setEnabled = (type: string, value: boolean) => {
                    const updated = { ...normalized };
                    visibleLabelTypes.forEach((option) => {
                        updated[option] = {
                            ...(updated[option] ?? {}),
                            value:
                                option === type
                                    ? value
                                    : (updated[option]?.value ?? false),
                            level: currentLevel,
                        };
                    });
                    field.onChange(updated);
                };

                return (
                    <div
                        className="border-card-lv3/60 bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y overflow-hidden rounded-xl border"
                        data-field-name="analysisTypes">
                        {visibleLabels.map((label) => {
                            const enabled =
                                normalized[label.type]?.value ?? false;
                            return (
                                <CategoryRow
                                    key={label.type}
                                    type={label.type}
                                    name={label.name}
                                    description={label.description}
                                    enabled={enabled}
                                    disabled={field.disabled}
                                    onToggle={(value) =>
                                        setEnabled(label.type, value)
                                    }
                                    showMcpWarning={
                                        label.type === "business_logic" &&
                                        enabled &&
                                        isMCPFetched &&
                                        !hasTaskMcp
                                    }
                                    promptDefault={
                                        promptCategoryOf(label.type)
                                            ? defaults?.categories
                                                  ?.descriptions?.[
                                                  promptCategoryOf(
                                                      label.type,
                                                  ) as PromptCategory
                                              ]
                                            : undefined
                                    }
                                    canEdit={canEdit}
                                />
                            );
                        })}
                    </div>
                );
            }}
        />
    );
};
