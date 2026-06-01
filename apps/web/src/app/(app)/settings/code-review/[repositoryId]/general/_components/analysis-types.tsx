"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import { Badge } from "@components/ui/badge";
import { Checkbox } from "@components/ui/checkbox";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCPServiceUnavailableError } from "@services/mcp-manager/utils";
import { useQuery } from "@tanstack/react-query";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { useCurrentConfigLevel } from "src/app/(app)/settings/_hooks";

import {
    filterVisibleReviewLabels,
    mergeMissingReviewOptions,
} from "../_utils/review-options-state";
import { OverrideIndicatorForm } from "../../../_components/override";
import { type CodeReviewFormType } from "../../../_types";

const TASK_MANAGEMENT_HINTS = [
    "jira",
    "linear",
    "notion",
    "clickup",
    "googledocs",
    "atlassianrovo",
    "githubissues",
];

function normalizeToken(value: string): string {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasTaskManagementConnection(
    connections: Array<{ appName: string; provider: string }>,
): boolean {
    return connections.some((conn) => {
        const aliases = [conn.appName, conn.provider]
            .map(normalizeToken)
            .filter(Boolean);
        return aliases.some((alias) =>
            TASK_MANAGEMENT_HINTS.some(
                (hint) => alias.includes(hint) || hint.includes(alias),
            ),
        );
    });
}

interface CheckboxCardOption {
    value: string;
    name: string;
    description: string;
}

export const AnalysisTypes = () => {
    const currentLevel = useCurrentConfigLevel();
    const form = useFormContext<CodeReviewFormType>();
    const reviewOptions = useWatch({
        control: form.control,
        name: "reviewOptions",
    });
    const { data: labels = [], isLoading } = useGetCodeReviewLabels("v2");

    // Business-logic review used to be gated by a `businessLogic`
    // client-side feature flag. The flag was promoted to GA in the
    // feature-gate PR, so the MCP plugin lookup it guarded now runs for
    // every org.
    const { data: mcpPlugins, isFetched: isMCPFetched } = useQuery({
        queryKey: ["mcp-plugins-task-management"],
        staleTime: 5 * 60 * 1000,
        retry: false,
        queryFn: async () => {
            try {
                return await getMCPPlugins();
            } catch (error) {
                if (error instanceof MCPServiceUnavailableError) {
                    return null;
                }
                return null;
            }
        },
    });
    const hasTaskMcp = useMemo(() => {
        if (!mcpPlugins) return false;
        const connected = mcpPlugins.filter((p) => p.isConnected);
        return hasTaskManagementConnection(connected);
    }, [mcpPlugins]);
    const visibleLabels = useMemo(
        () => filterVisibleReviewLabels(labels, true),
        [labels],
    );
    const visibleLabelTypes = useMemo(
        () => visibleLabels.map((label) => label.type),
        [visibleLabels],
    );

    const reviewOptionsOptions: CheckboxCardOption[] = visibleLabels.map(
        (label) => ({
            value: label.type,
            name: label.name,
            description: label.description,
        }),
    );

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="text-text-secondary">Loading categories...</div>
            </div>
        );
    }

    return (
        <Controller
            name="reviewOptions"
            control={form.control}
            render={({ field }) => {
                const normalizedOptions = mergeMissingReviewOptions(
                    (field.value || reviewOptions || {}) as Record<
                        string,
                        { value: boolean; level: typeof currentLevel }
                    >,
                    visibleLabelTypes,
                );

                return (
                    <FormControl.Root className="@container space-y-1">
                        <FormControl.Input>
                            <ToggleGroup.Root
                                id={field.name}
                                type="multiple"
                                disabled={field.disabled}
                                className="grid auto-rows-fr grid-cols-1 gap-2 @lg:grid-cols-2 @3xl:grid-cols-3"
                                value={Object.entries(normalizedOptions)
                                    .filter(([, prop]) => prop.value)
                                    .map(([key]) => key)}
                                onValueChange={(values) => {
                                    const updatedOptions = {
                                        ...normalizedOptions,
                                    };

                                    visibleLabelTypes.forEach((option) => {
                                        const isSelected =
                                            values.includes(option);
                                        const existingOption =
                                            updatedOptions[option];

                                        if (existingOption) {
                                            updatedOptions[option] = {
                                                ...existingOption,
                                                value: isSelected,
                                                level: currentLevel,
                                            };
                                        } else {
                                            updatedOptions[option] = {
                                                value: isSelected,
                                                level: currentLevel,
                                            };
                                        }
                                    });

                                    field.onChange(updatedOptions);
                                }}>
                                {reviewOptionsOptions.map((option) => {
                                    const isEnabled =
                                        normalizedOptions[option.value]
                                            ?.value || false;
                                    const showMcpWarning =
                                        option.value === "business_logic" &&
                                        isEnabled &&
                                        isMCPFetched &&
                                        !hasTaskMcp;
                                    return (
                                        <ToggleGroup.ToggleGroupItem
                                            key={option.value}
                                            asChild
                                            value={option.value}>
                                            <Button
                                                size="lg"
                                                variant="helper"
                                                className={`w-full items-start py-5 ${showMcpWarning ? "border-danger" : ""}`}>
                                                <div className="flex w-full flex-row justify-between gap-6">
                                                    <div className="flex min-w-0 flex-col gap-2">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <Heading
                                                                variant="h3"
                                                                className="truncate">
                                                                {option.name}
                                                            </Heading>
                                                            <OverrideIndicatorForm
                                                                fieldName={`reviewOptions.${option.value}`}
                                                            />
                                                            {showMcpWarning && (
                                                                <Badge className="bg-red-500/10 text-red-500 border-red-500/20 text-[10px] whitespace-nowrap">
                                                                    Connect a
                                                                    task
                                                                    management
                                                                    MCP
                                                                </Badge>
                                                            )}
                                                        </div>

                                                        <p className="text-text-secondary text-xs">
                                                            {option.description}
                                                        </p>
                                                    </div>

                                                    <Checkbox
                                                        decorative
                                                        checked={isEnabled}
                                                    />
                                                </div>
                                            </Button>
                                        </ToggleGroup.ToggleGroupItem>
                                    );
                                })}
                            </ToggleGroup.Root>
                        </FormControl.Input>
                    </FormControl.Root>
                );
            }}
        />
    );
};
