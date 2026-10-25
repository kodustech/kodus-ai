"use client";

import { useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Link } from "@components/ui/link";
import { Switch } from "@components/ui/switch";
import {
    useBusinessLogicStatus,
    useTaskSources,
} from "@services/business-logic/hooks";
import type { BusinessLogicStatus } from "@services/business-logic/types";
import { KODUS_ISSUES_INTEGRATION_ID } from "@services/mcp-manager/types";
import { useGetCodeReviewLabels } from "@services/parameters/hooks";
import { EllipsisIcon, FlaskConicalIcon, PencilIcon } from "lucide-react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import {
    useCodeReviewRouteParams,
    useCurrentConfigLevel,
} from "src/app/(app)/settings/_hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";
import { CustomAgentsSectionGate } from "src/features/ee/custom-agents/custom-agents-plan-gate";

import { CustomAgentsSection } from "../../_custom-agents/custom-agents-section";
import { OverrideIndicatorForm } from "../../../_components/override";
import { type CodeReviewFormType } from "../../../_types";
import { useDefaultCodeReviewConfig } from "../../../../_components/context";
import { PromptEditorField } from "../../custom-prompts/_components/prompt-editor-field";
import {
    getPromptFieldText,
    parsePromptFieldValue,
} from "../../custom-prompts/_utils/custom-prompts-state";
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

/**
 * What the Business Logic row says under its description: where tasks come
 * from and how it went, or why it stopped (UC-06, UC-07).
 */
const BusinessLogicSummary = ({
    status,
    hasTaskMcp,
    gitIssuesConnected,
    lookupFailed,
}: {
    status?: BusinessLogicStatus;
    hasTaskMcp: boolean;
    /** Git Issues reads the issues those skipped PRs referenced. */
    gitIssuesConnected?: boolean;
    /** The plugin lookup failed: we can't say whether a tracker is connected. */
    lookupFailed?: boolean;
}) => {
    if (lookupFailed) {
        return (
            <p className="text-text-secondary text-xs">
                Couldn&apos;t check your plugins right now.
            </p>
        );
    }
    if (!hasTaskMcp) {
        return (
            <p className="text-warning text-xs">
                No task tracker is connected, so nothing is checked.{" "}
                <Link href="/settings/plugins">Connect one in Plugins</Link>
            </p>
        );
    }
    if (status?.state === "paused" && status.paused) {
        return (
            <p className="text-warning text-xs">
                Paused. {status.paused.tracker} hasn&apos;t answered since{" "}
                {new Date(status.paused.since).toLocaleString()};{" "}
                {status.paused.uncheckedPullRequests} PRs weren&apos;t checked.{" "}
                <Link href="/settings/plugins">
                    Reconnect {status.paused.tracker}
                </Link>
            </p>
        );
    }
    return (
        <p className="text-text-secondary text-xs">
            {status?.lastTaskRead
                ? `Last task read from ${status.lastTaskRead.tracker} · ${status.stats.pullRequestsChecked} PRs checked in the last 30 days`
                : "Waiting for the first pull request that references a task"}
            {status?.pointsElsewhere && !gitIssuesConnected && (
                <>
                    {" "}
                    · {status.pointsElsewhere.pullRequests} PRs referenced
                    repository issues (#12) no connected tracker reads; they
                    were skipped without a comment.{" "}
                    <Link href="/settings/plugins">Connect Git Issues</Link>
                </>
            )}
        </p>
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
    summary,
    href,
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
    summary?: ReactNode;
    /** A category with a page of its own: the name opens it, and a menu
     *  edits or tries it, as a custom agent's row does. */
    href?: string;
}) => {
    const router = useRouter();
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
                        {href ? (
                            <Link
                                href={href}
                                className="text-text-primary text-sm font-medium hover:underline">
                                {name}
                            </Link>
                        ) : (
                            <label
                                htmlFor={switchId}
                                className="text-text-primary cursor-pointer text-sm font-medium">
                                {name}
                            </label>
                        )}
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
                    {enabled && summary}
                </div>

                {href && (
                    <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="icon-xs"
                                variant="cancel"
                                className="ml-auto shrink-0 self-center"
                                aria-label={`More actions for ${name}`}
                                title="More actions">
                                <EllipsisIcon aria-hidden />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onSelect={() => router.push(href)}>
                                <PencilIcon className="size-4" aria-hidden />
                                {canEdit ? "Edit" : "View"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onSelect={() => router.push(`${href}#try-it`)}>
                                <FlaskConicalIcon
                                    className="size-4"
                                    aria-hidden
                                />
                                Try it
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}

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
    const { teamId } = useSelectedTeamId();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const { data: businessLogicStatus } = useBusinessLogicStatus({
        teamId,
        repositoryId,
        enabled: businessLogicEnabled,
    });
    const configureHref = `/settings/code-review/${repositoryId}/business-logic${
        directoryId ? `?directoryId=${directoryId}` : ""
    }`;

    // The sources Business Logic reads, as the backend builds them: Git
    // Issues and custom task plugins included, which name hints miss.
    const taskSource = useWatch({
        control: form.control,
        name: "businessLogic.taskSource.value" as never,
    }) as string | undefined;
    const {
        data: taskSources,
        isFetched: isMCPFetched,
        isError: taskSourcesFailed,
    } = useTaskSources(businessLogicEnabled ? teamId : undefined);
    const hasTaskMcp = useMemo(
        () =>
            !!taskSources?.some((source) =>
                taskSource && taskSource !== "auto"
                    ? source.integrationId === taskSource
                    : source.inAuto,
            ),
        [taskSources, taskSource],
    );

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

    const categories = (
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
                                    // The summary below says it, with a link.
                                    showMcpWarning={false}
                                    summary={
                                        label.type === "business_logic" &&
                                        isMCPFetched ? (
                                            <BusinessLogicSummary
                                                status={businessLogicStatus}
                                                hasTaskMcp={hasTaskMcp}
                                                gitIssuesConnected={
                                                    !!taskSources?.some(
                                                        (source) =>
                                                            source.integrationId ===
                                                            KODUS_ISSUES_INTEGRATION_ID,
                                                    )
                                                }
                                                lookupFailed={taskSourcesFailed}
                                            />
                                        ) : undefined
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
                                    href={
                                        label.type === "business_logic"
                                            ? configureHref
                                            : undefined
                                    }
                                />
                            );
                        })}
                    </div>
                );
            }}
        />
    );

    return (
        <div className="flex flex-col gap-8">
            {categories}
            <CustomAgentsSectionGate>
                <CustomAgentsSection canEdit={canEdit} />
            </CustomAgentsSectionGate>
        </div>
    );
};
