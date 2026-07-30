import React, { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { CodeInputSimple } from "@components/ui/code-input-simple";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import {
    HoverCard,
    HoverCardContent,
    HoverCardTrigger,
} from "@components/ui/hover-card";
import { Input } from "@components/ui/input";
import { KodyReviewPreview } from "@components/ui/kody-review-preview";
import { Label } from "@components/ui/label";
import { magicModal } from "@components/ui/magic-modal";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import {
    RichTextEditorWithMentions,
    type RichTextEditorWithMentionsRef,
} from "@components/ui/rich-text-editor-with-mentions";
import { Separator } from "@components/ui/separator";
import { SliderWithMarkers } from "@components/ui/slider-with-markers";
import { Switch } from "@components/ui/switch";
import { useToast } from "@components/ui/toaster/use-toast";
import { ToggleGroup } from "@components/ui/toggle-group";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import {
    createOrUpdateKodyRule,
    getRecommendedKodyRules,
} from "@services/kodyRules/fetch";
import {
    KodyRuleInheritanceOrigin,
    KodyRulesOrigin,
    KodyRulesStatus,
    KodyRulesType,
    KodyRuleWithInheritanceDetails,
    resolveKodyRuleDisplaySeverity,
    type KodyRule,
    type LibraryRule,
} from "@services/kodyRules/types";
import { isCentralizedPrResponse } from "@services/parameters/types";
import {
    CheckIcon,
    ChevronDown,
    Code2,
    ExternalLink,
    FileCode,
    GitPullRequest,
    HelpCircle,
    Info,
    Lightbulb,
    PlusIcon,
    SaveIcon,
    Settings2,
    Sparkles,
    XIcon,
} from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import type { FormattedDirectoryCodeReviewConfig } from "../_types";
import { getCentralizedPrToastPayload } from "../_utils/centralized-pr-feedback";
import { ExternalReferencesDisplay } from "../[repositoryId]/pr-summary/_components/external-references-display";

const severityOptions: {
    value: KodyRule["severity"];
    label: string;
    description: string;
    textColor: string;
    borderColor: string;
}[] = [
        {
            value: "low",
            label: "Low",
            description: "Minor improvements and low-risk issues",
            textColor: "text-info",
            borderColor: "border-info",
        },
        {
            value: "medium",
            label: "Medium",
            description: "Recommended fixes that improve correctness or quality",
            textColor: "text-alert",
            borderColor: "border-alert",
        },
        {
            value: "high",
            label: "High",
            description: "Important problems that should be fixed in the PR",
            textColor: "text-warning",
            borderColor: "border-warning",
        },
        {
            value: "critical",
            label: "Critical",
            description:
                "Severe bugs, security vulnerabilities, or data loss risks",
            textColor: "text-danger",
            borderColor: "border-danger",
        },
    ];

const severitySliderOptions = {
    low: { label: "Low", value: 0 },
    medium: { label: "Medium", value: 1 },
    high: { label: "High", value: 2 },
    critical: { label: "Critical", value: 3 },
} satisfies Record<KodyRule["severity"], { label: string; value: number }>;

const executionModeOptions = [
    {
        value: "file",
        name: "Per file",
        description: "Runs once for each changed file",
        output: "Inline review comments",
        icon: FileCode,
    },
    {
        value: "pull-request",
        name: "Per PR",
        description: "Runs once for the whole PR",
        output: "Single PR comment",
        icon: GitPullRequest,
    },
] as const;

const PR_CONTEXT_VARIABLES = [
    { key: "pr_title", label: "pr_title" },
    { key: "pr_description", label: "pr_description" },
    { key: "pr_total_additions", label: "pr_total_additions" },
    { key: "pr_total_deletions", label: "pr_total_deletions" },
    { key: "pr_total_files", label: "pr_total_files" },
    { key: "pr_total_lines_changed", label: "pr_total_lines_changed" },
    { key: "pr_files_diff", label: "pr_files_diff" },
    { key: "pr_tags", label: "pr_tags" },
    { key: "pr_author", label: "pr_author" },
    { key: "pr_number", label: "pr_number" },
] as const;

const FILE_CONTEXT_VARIABLES = [
    { key: "fileDiff", label: "fileDiff" },
] as const;

const INSTRUCTIONS_PLACEHOLDER = `Write the instructions for this rule.

Use variables to access context:
- Per PR: pr_title, pr_description, pr_files_diff...
- Per file: fileDiff
`;

const BAD_EXAMPLE_PLACEHOLDER = `for (var i = 1; i != 10; i += 2)  // Noncompliant. Infinite; i goes from 9 straight to 11.
{
  //...
}`;

const GOOD_EXAMPLE_PLACEHOLDER = `for (var i = 1; i <= 10; i += 2)  // Compliant
{
  //...
}`;

const RULE_SUGGESTIONS = [
    {
        title: "Avoid console.log in production",
        description: "Keep your code clean and secure",
        rule: "Search for any `console.log()`, `console.warn()`, or `console.error()` statements in the code.\n\nIf found, suggest:\n- Removing them if they're for debugging purposes\n- Replacing them with a proper logging library\n- Using environment-based conditional logging",
    },
    {
        title: "Add error handling to async functions",
        description: "Prevent unhandled promise rejections",
        rule: "Check if async functions have appropriate error handling.\n\nIf missing, suggest:\n- Adding try-catch blocks around async operations\n- Returning error responses or throwing custom errors\n- Handling promise rejections properly",
    },
    {
        title: "Remove unused imports",
        description: "Optimize bundle size and readability",
        rule: "Identify any imported modules, functions, or components that are not being used in the file.\n\nIf found, suggest removing them to keep the code clean and reduce bundle size.",
    },
    {
        title: "Use meaningful variable names",
        description: "Improve code maintainability",
        rule: "Check for single-letter or unclear variable names (except in common cases like loop indices).\n\nSuggest using descriptive names that indicate the variable's purpose.",
    },
    {
        title: "Add JSDoc comments to public functions",
        description: "Document your API for better DX",
        rule: "Check if exported/public functions have JSDoc comments explaining their purpose, parameters, and return values.\n\nIf missing, suggest adding documentation.",
    },
];

function RuleSuggestions({
    onSelectSuggestion,
    currentValue,
    disabled,
}: {
    onSelectSuggestion: (rule: string) => void;
    currentValue: string;
    disabled?: boolean;
}) {
    const [recommendedRules, setRecommendedRules] = useState<LibraryRule[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        const fetchSuggestions = async () => {
            try {
                const rules = await getRecommendedKodyRules({ limit: 6 });
                setRecommendedRules(rules || []);
            } catch (error) {
                console.error("Failed to fetch recommended rules:", error);
            } finally {
                setIsLoading(false);
            }
        };

        if (!currentValue) {
            fetchSuggestions();
        } else {
            setIsLoading(false);
        }
    }, [currentValue]);

    if (currentValue) return null;

    const apiSuggestions = recommendedRules.map((r) => ({
        title: r.title,
        rule: r.rule,
    }));

    const fallbackSuggestions = RULE_SUGGESTIONS.map((s) => ({
        title: s.title,
        rule: s.rule,
    }));

    const suggestions = [...apiSuggestions];

    if (suggestions.length < 5) {
        const needed = 5 - suggestions.length;
        const fallbackToAdd = fallbackSuggestions
            .filter(
                (fallback) =>
                    !suggestions.some((s) => s.title === fallback.title),
            )
            .slice(0, needed);
        suggestions.push(...fallbackToAdd);
    }

    return (
        <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2">
                <Lightbulb className="text-primary-light size-3.5" />
                <span className="text-text-secondary text-xs font-medium">
                    Start with a popular template:
                </span>
            </div>

            {isLoading ? (
                <div className="flex flex-wrap gap-2">
                    {[...Array(4)].map((_, i) => (
                        <div
                            key={i}
                            className="bg-card-lv3/50 h-8 w-32 animate-pulse rounded-full"
                            style={{ animationDelay: `${i * 100}ms` }}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex flex-wrap gap-2">
                    {suggestions.map((suggestion, index) => (
                        <button
                            key={index}
                            type="button"
                            disabled={disabled}
                            onClick={() => onSelectSuggestion(suggestion.rule)}
                            className={cn(
                                "group relative inline-flex items-center gap-1.5 rounded-full px-3 py-1.5",
                                "bg-card-lv3 border-card-lv3 border",
                                "hover:border-primary-light hover:bg-primary-dark/40 hover:scale-105",
                                "active:scale-95",
                                "transition-all duration-200",
                                "disabled:cursor-not-allowed disabled:opacity-50",
                                "animate-fade-in-up opacity-0",
                            )}
                            style={{
                                animationDelay: `${index * 80}ms`,
                                animationFillMode: "forwards",
                            }}>
                            <Sparkles className="text-primary-light size-3 opacity-60 transition-all duration-200 group-hover:rotate-12 group-hover:opacity-100" />
                            <span className="text-text-secondary group-hover:text-text-primary text-xs font-medium transition-colors">
                                {suggestion.title}
                            </span>
                            <div className="bg-primary-light/0 group-hover:bg-primary-light/5 absolute inset-0 rounded-full transition-colors duration-200" />
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}


export const KodyRuleAddOrUpdateItemModal = ({
    repositoryId,
    directory,
    rule,
    ruleType = KodyRulesType.STANDARD,
    onClose,
    canEdit,
}: {
    rule?: KodyRuleWithInheritanceDetails;
    directory?: FormattedDirectoryCodeReviewConfig;
    repositoryId: string;
    ruleType?: KodyRulesType;
    onClose?: () => void;
    canEdit: boolean;
}) => {
    const { toast } = useToast();
    const { teamId } = useSelectedTeamId();
    const queryClient = useQueryClient();

    const initialScope = rule?.scope ?? "file";

    const isInherited = !!rule?.inherited;
    const entityLabel =
        (rule?.type ?? ruleType) === KodyRulesType.MEMORY ? "Memory" : "Rule";
    const isMemory = (rule?.type ?? ruleType) === KodyRulesType.MEMORY;

    const isExcluded = !!rule?.inheritance?.exclude?.find(
        (id) => id === directory?.id || id === repositoryId,
    );

    const [isInheritanceDisabled, setIsInheritanceDisabled] =
        useState(isExcluded);

    const editorRef = React.useRef<RichTextEditorWithMentionsRef>(null);

    const form = useForm<
        Omit<KodyRule, "examples" | "inheritance"> & {
            badExample: string;
            goodExample: string;
            inheritable: boolean;
        }
    >({
        mode: "all",
        reValidateMode: "onChange",
        criteriaMode: "firstError",
        disabled: !canEdit || isInherited,
        defaultValues: {
            path:
                initialScope === "pull-request" || directory
                    ? ""
                    : rule?.path ?? "",
            rule: rule?.rule ?? "",
            title: rule?.title ?? "",
            severity: rule ? resolveKodyRuleDisplaySeverity(rule) : "high",
            scope: initialScope,
            badExample:
                rule?.examples?.find(({ isCorrect }) => !isCorrect)?.snippet ??
                "",
            goodExample:
                rule?.examples?.find(({ isCorrect }) => isCorrect)?.snippet ??
                "",
            origin: rule?.origin ?? KodyRulesOrigin.MANUAL,
            status: rule?.status ?? KodyRulesStatus.ACTIVE,
            type: rule?.type ?? ruleType,
            inheritable: rule?.inheritance?.inheritable ?? true,
        },
    });

    const formState = form.formState;
    const watchScope = form.watch("scope");

    const handleSubmit = form.handleSubmit(async (config) => {
        if (!onClose) {
            magicModal.lock();
        }

        try {
            let examples = [];
            if (!isMemory && config.badExample)
                examples.push({ isCorrect: false, snippet: config.badExample });
            if (!isMemory && config.goodExample)
                examples.push({ isCorrect: true, snippet: config.goodExample });

            let newPath = "";
            if (!isMemory && config.scope === "file" && !directory) {
                newPath = config.path;
            }

            const mutationResult = await createOrUpdateKodyRule(
                {
                    path: newPath,
                    rule: config.rule,
                    title: config.title,
                    severity: isMemory ? "high" : config.severity,
                    scope: isMemory ? "file" : config.scope,
                    uuid: rule?.uuid,
                    examples: examples,
                    origin: config.origin ?? KodyRulesOrigin.MANUAL,
                    status: config.status ?? KodyRulesStatus.ACTIVE,
                    type: config.type ?? ruleType,
                    centralizedConfig: rule?.centralizedConfig,
                    inheritance: {
                        ...(rule?.inheritance ?? {
                            inheritable: true,
                            exclude: [],
                            include: [],
                        }),
                        inheritable: config.inheritable,
                    },
                },
                repositoryId,
                directory?.id,
                teamId,
            );

            if (isCentralizedPrResponse(mutationResult)) {
                toast(
                    getCentralizedPrToastPayload(
                        mutationResult,
                        `${entityLabel} change proposed through centralized pull request.`,
                    ),
                );
            } else {
                toast({
                    description: `${entityLabel} ${rule?.uuid ? "updated" : "created"}`,
                    variant: "success",
                });
            }

            if (!onClose) {
                magicModal.hide(true);
            } else {
                onClose();
            }
        } catch (error) {
            console.error("Error updating rule:", error);

            toast({
                title: "Error",
                description: `An error occurred while ${rule?.uuid ? "updating" : "creating"} the ${entityLabel.toLowerCase()}. Please try again later.`,
                variant: "alert",
            });

            if (!onClose) {
                magicModal.unlock();
            }
        }
    });

    const handleDisableInherited = async (val: boolean) => {
        magicModal.lock();

        setIsInheritanceDisabled(val);

        const targetId = directory?.id || repositoryId;

        const excludeList = rule?.inheritance?.exclude
            ? [...rule.inheritance.exclude]
            : [];

        if (!val) {
            const index = excludeList.indexOf(targetId);
            if (index !== -1) excludeList.splice(index, 1);
        } else {
            if (!excludeList.includes(targetId)) excludeList.push(targetId);
        }

        try {
            const mutationResult = await createOrUpdateKodyRule(
                {
                    path: rule?.path,
                    rule: rule?.rule,
                    title: rule?.title,
                    severity: rule?.severity,
                    scope: rule?.scope,
                    uuid: rule?.uuid,
                    examples: rule?.examples,
                    origin: rule?.origin ?? KodyRulesOrigin.MANUAL,
                    status: rule?.status ?? KodyRulesStatus.ACTIVE,
                    type: rule?.type ?? ruleType,
                    centralizedConfig: rule?.centralizedConfig,
                    inheritance: {
                        ...(rule?.inheritance ?? {
                            inheritable: true,
                            exclude: [],
                            include: [],
                        }),
                        exclude: excludeList,
                    },
                } as KodyRule,
                rule?.repositoryId,
                rule?.directoryId,
                teamId,
            );

            if (isCentralizedPrResponse(mutationResult)) {
                setIsInheritanceDisabled(!val);
                toast(
                    getCentralizedPrToastPayload(
                        mutationResult,
                        "Rule inheritance change proposed through centralized pull request.",
                    ),
                );
                return;
            }

            queryClient.invalidateQueries({
                predicate: (query) =>
                    query.queryKey[0] ===
                        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER ||
                    query.queryKey[0] ===
                        KODY_RULES_PATHS.GET_INHERITED_RULES,
            });

            const toastData = {
                title: val ? "Disabled inheritance" : "Enabled inheritance",
                description: val
                    ? "This rule is no longer being inherited for this scope."
                    : "This rule is now being inherited from higher scopes.",
                variant: "success" as const,
            };

            toast(toastData);
        } catch {
            setIsInheritanceDisabled(!val);
            toast({
                variant: "alert",
                description:
                    "An error occurred while disabling inheritance. Please try again.",
                title: "Error disabling inheritance",
            });
        } finally {
            magicModal.unlock();
        }
    };

    let title = `Add new ${entityLabel.toLowerCase()}`;
    if (isInherited) {
        title = `View inherited ${entityLabel.toLowerCase()}`;
    } else if (!canEdit) {
        title = `View ${entityLabel.toLowerCase()}`;
    } else if (rule) {
        title = `Edit ${entityLabel.toLowerCase()}`;
    }

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) {
                    if (onClose) {
                        onClose();
                    } else {
                        magicModal.hide();
                    }
                }
            }}>
            <DialogContent className="max-w-(--breakpoint-lg)">
                <DialogHeader>
                    <div className="flex items-center justify-between">
                        <DialogTitle>{title}</DialogTitle>
                        <a
                            href="https://docs.kodus.io/how_to_use/en/code_review/configs/kody_rules"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-text-secondary hover:text-primary-light flex items-center gap-1 text-xs transition-colors">
                            Docs
                            <ExternalLink className="size-3" />
                        </a>
                    </div>
                </DialogHeader>

                {isInherited && (
                    <div className="bg-card-lv1 mb-4 flex flex-col gap-4 rounded-lg border p-4 px-6">
                        <div className="flex items-center gap-2">
                            <Info className="text-text-secondary size-5" />
                            <Heading variant="h3" className="text-base">
                                Inherited {entityLabel}
                            </Heading>
                        </div>
                        <p className="text-text-secondary text-sm">
                            {rule.inherited ===
                                KodyRuleInheritanceOrigin.GLOBAL &&
                                `This ${entityLabel.toLowerCase()} is inherited from the Global configuration. To edit it, you must go to the global Kody Rules settings.`}
                            {rule.inherited ===
                                KodyRuleInheritanceOrigin.REPOSITORY &&
                                `This ${entityLabel.toLowerCase()} is inherited from the Repository configuration. To edit it, you must go to the repository Kody Rules settings.`}
                            {rule.inherited ===
                                KodyRuleInheritanceOrigin.DIRECTORY &&
                                `This ${entityLabel.toLowerCase()} is inherited from another Directory configuration. This is likely due to how the ${entityLabel.toLowerCase()}'s path is defined. To edit it, you must go to the Kody Rules settings for the directory where it was created.`}
                        </p>
                        <Separator />
                        <div className="flex items-center justify-between">
                            <Label
                                htmlFor="disable-inheritance"
                                className="text-sm font-medium">
                                Override and disable for this scope
                            </Label>
                            <Switch
                                id="disable-inheritance"
                                disabled={!canEdit}
                                onCheckedChange={handleDisableInherited}
                                checked={isInheritanceDisabled}
                            />
                        </div>
                    </div>
                )}

                <div className="-mx-6 flex flex-col gap-8 overflow-y-auto px-6 py-1">
                    <Controller
                        name="title"
                        rules={{
                            required: `${entityLabel} name is required`,
                        }}
                        control={form.control}
                        render={({ field, fieldState }) => (
                            <div className="grid grid-cols-[1fr_3fr] items-center gap-6">
                                <FormControl.Root>
                                    <FormControl.Label
                                        className="mb-0 flex flex-row gap-1"
                                        htmlFor={field.name}>
                                        {entityLabel} name
                                    </FormControl.Label>
                                </FormControl.Root>

                                <FormControl.Input>
                                    <div>
                                        <Input
                                            id={field.name}
                                            error={fieldState.error}
                                            placeholder="Avoid using 'console.log' statements in production code."
                                            maxLength={300}
                                            value={field.value}
                                            disabled={field.disabled}
                                            onChange={(e) =>
                                                field.onChange(e.target.value)
                                            }
                                        />

                                        <FormControl.Error>
                                            {fieldState.error?.message}
                                        </FormControl.Error>
                                    </div>
                                </FormControl.Input>
                            </div>
                        )}
                    />

                    <Controller
                        name="scope"
                        control={form.control}
                        render={({ field }) => {
                            if (isMemory) return <></>;

                            return (
                                <div className="flex flex-col gap-4">
                                    <div className="grid grid-cols-[1fr_3fr] gap-6">
                                        <FormControl.Root>
                                            <FormControl.Label className="mb-0 flex flex-row gap-1">
                                                Execution mode
                                                <HoverCard
                                                    openDelay={100}
                                                    closeDelay={200}>
                                                    <HoverCardTrigger asChild>
                                                        {/* tabIndex -1: in view mode the rule-name input is
                                                            disabled, so the dialog's open auto-focus would land
                                                            on this button — and HoverCard opens on focus,
                                                            covering the modal. Hover-only is fine for help. */}
                                                        <button
                                                            type="button"
                                                            tabIndex={-1}>
                                                            <HelpCircle
                                                                size={16}
                                                                className="text-primary-light hover:text-primary-light/80 transition-colors"
                                                            />
                                                        </button>
                                                    </HoverCardTrigger>

                                                    <HoverCardContent
                                                        align="start"
                                                        side="right"
                                                        className="w-96 p-0">
                                                        <div className="border-card-lv3 border-b p-4">
                                                            <h4 className="text-text-primary mb-1 text-sm font-medium">
                                                                Execution mode
                                                            </h4>
                                                            <p className="text-text-secondary text-xs">
                                                                Choose how Kody
                                                                analyzes your
                                                                code and where
                                                                comments appear.
                                                            </p>
                                                        </div>

                                                        <div className="space-y-4 p-4">
                                                            <div className="space-y-2">
                                                                <div className="flex items-center gap-2">
                                                                    <FileCode className="text-primary-light size-4" />
                                                                    <span className="text-text-primary text-xs font-medium">
                                                                        Per file
                                                                    </span>
                                                                </div>
                                                                <p className="text-text-secondary pl-6 text-xs">
                                                                    Rule runs
                                                                    once for
                                                                    each changed
                                                                    file. Best
                                                                    for
                                                                    file-specific
                                                                    validations
                                                                    like code
                                                                    style,
                                                                    patterns, or
                                                                    security
                                                                    checks.
                                                                </p>
                                                                <div className="pl-6">
                                                                    <KodyReviewPreview
                                                                        mode="inline"
                                                                        comment="Consider adding error handling here."
                                                                        codeLine={{
                                                                            number: 12,
                                                                            content:
                                                                                "await fetchData();",
                                                                        }}
                                                                    />
                                                                </div>
                                                            </div>

                                                            <div className="border-card-lv3 space-y-2 border-t pt-4">
                                                                <div className="flex items-center gap-2">
                                                                    <GitPullRequest className="text-primary-light size-4" />
                                                                    <span className="text-text-primary text-xs font-medium">
                                                                        Per PR
                                                                    </span>
                                                                </div>
                                                                <p className="text-text-secondary pl-6 text-xs">
                                                                    Rule runs
                                                                    once for the
                                                                    entire PR.
                                                                    Best for
                                                                    cross-file
                                                                    analysis,
                                                                    business
                                                                    logic
                                                                    validation,
                                                                    or summary
                                                                    reviews.
                                                                </p>
                                                                <div className="pl-6">
                                                                    <KodyReviewPreview
                                                                        mode="pr-comment"
                                                                        comment="PR description is missing required sections: 'Testing' and 'Breaking Changes'."
                                                                    />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </HoverCardContent>
                                                </HoverCard>
                                            </FormControl.Label>
                                            <FormControl.Helper>
                                                How many times this{" "}
                                                {entityLabel.toLowerCase()} runs
                                            </FormControl.Helper>
                                        </FormControl.Root>

                                        <FormControl.Input>
                                            <ToggleGroup.Root
                                                type="single"
                                                className="flex w-full gap-3"
                                                value={field.value}
                                                disabled={field.disabled}
                                                onValueChange={(value) => {
                                                    if (value)
                                                        field.onChange(value);

                                                    if (value === "file") {
                                                        form.setValue(
                                                            "path",
                                                            "",
                                                            {
                                                                shouldValidate: true,
                                                            },
                                                        );
                                                    } else if (
                                                        value === "pull-request"
                                                    ) {
                                                        form.resetField(
                                                            "path",
                                                            {
                                                                defaultValue:
                                                                    "",
                                                            },
                                                        );
                                                    }
                                                }}>
                                                {executionModeOptions.map(
                                                    (option) => {
                                                        const Icon =
                                                            option.icon;
                                                        const isSelected =
                                                            option.value ===
                                                            field.value;
                                                        return (
                                                            <ToggleGroup.ToggleGroupItem
                                                                asChild
                                                                key={
                                                                    option.value
                                                                }
                                                                value={
                                                                    option.value
                                                                }>
                                                                <Button
                                                                    size="md"
                                                                    variant="helper"
                                                                    className={cn(
                                                                        "h-auto flex-1 items-start px-4 py-4",
                                                                        isSelected &&
                                                                        "ring-primary-light ring-2",
                                                                    )}>
                                                                    <div className="flex w-full items-start justify-between gap-3">
                                                                        <div className="flex items-start gap-3">
                                                                            <div
                                                                                className={cn(
                                                                                    "flex size-9 items-center justify-center rounded-lg",
                                                                                    isSelected
                                                                                        ? "bg-primary-light/20"
                                                                                        : "bg-card-lv3",
                                                                                )}>
                                                                                <Icon
                                                                                    className={cn(
                                                                                        "size-5",
                                                                                        isSelected
                                                                                            ? "text-primary-light"
                                                                                            : "text-text-secondary",
                                                                                    )}
                                                                                />
                                                                            </div>
                                                                            <div className="flex flex-col gap-1 text-left">
                                                                                <span className="text-sm font-medium">
                                                                                    {
                                                                                        option.name
                                                                                    }
                                                                                </span>
                                                                                <span className="text-text-secondary text-xs">
                                                                                    {
                                                                                        option.description
                                                                                    }
                                                                                </span>
                                                                                <span
                                                                                    className={cn(
                                                                                        "text-xs",
                                                                                        isSelected
                                                                                            ? "text-primary-light"
                                                                                            : "text-text-placeholder",
                                                                                    )}>
                                                                                    →{" "}
                                                                                    {
                                                                                        option.output
                                                                                    }
                                                                                </span>
                                                                            </div>
                                                                        </div>

                                                                        <Checkbox
                                                                            decorative
                                                                            checked={
                                                                                isSelected
                                                                            }
                                                                        />
                                                                    </div>
                                                                </Button>
                                                            </ToggleGroup.ToggleGroupItem>
                                                        );
                                                    },
                                                )}
                                            </ToggleGroup.Root>
                                        </FormControl.Input>
                                    </div>
                                </div>
                            );
                        }}
                    />

                    <Controller
                        name="path"
                        control={form.control}
                        rules={{}}
                        render={({ field, fieldState }) => {
                            if (isMemory) return <></>;

                            return (
                                <div className="grid grid-cols-[1fr_3fr] gap-6">
                                    <FormControl.Root>
                                        <FormControl.Label
                                            className="mb-0 flex flex-row gap-1"
                                            htmlFor={field.name}>
                                            Path
                                            <Tooltip>
                                                <TooltipTrigger tabIndex={-1}>
                                                    <HelpCircle
                                                        size={16}
                                                        className="text-primary-light"
                                                    />
                                                </TooltipTrigger>

                                                <TooltipContent
                                                    align="start"
                                                    className="flex max-w-prose flex-col gap-1 text-xs">
                                                    <p>
                                                        Define which files this
                                                        rule applies to using
                                                        glob patterns.
                                                    </p>
                                                    <p>
                                                        The{" "}
                                                        <code className="text-primary-light">
                                                            *
                                                        </code>{" "}
                                                        symbol matches any
                                                        sequence of characters,
                                                        includes subdirectories,
                                                        and{" "}
                                                        <code className="text-primary-light">
                                                            ?
                                                        </code>{" "}
                                                        matches a single
                                                        character.
                                                    </p>
                                                    <p>
                                                        For example,{" "}
                                                        <code className="text-primary-light">
                                                            /*.js
                                                        </code>{" "}
                                                        applies the rule to all
                                                        .js files in any folder
                                                        or subfolder.
                                                    </p>
                                                </TooltipContent>
                                            </Tooltip>
                                        </FormControl.Label>
                                        <FormControl.Helper>
                                            File path glob pattern.
                                        </FormControl.Helper>
                                    </FormControl.Root>

                                    <FormControl.Input>
                                        <div className="flex flex-col">
                                            <Input
                                                id={field.name}
                                                value={field.value}
                                                maxLength={600}
                                                placeholder="Example: **/*.js"
                                                error={fieldState.error}
                                                disabled={
                                                    field.disabled ||
                                                    watchScope ===
                                                    "pull-request" ||
                                                    !!directory
                                                }
                                                onChange={(e) =>
                                                    field.onChange(
                                                        e.target.value,
                                                    )
                                                }
                                            />

                                            <FormControl.Error>
                                                {fieldState.error?.message}
                                            </FormControl.Error>

                                            {watchScope === "pull-request" ? (
                                                <FormControl.Helper className="text-warning">
                                                    Path is not applicable for
                                                    pull request scope
                                                </FormControl.Helper>
                                            ) : directory ? (
                                                <FormControl.Helper>
                                                    <span className="inline-flex items-center gap-1">
                                                        This rule applies to all
                                                        folders in this
                                                        directory group.
                                                        <Tooltip>
                                                            <TooltipTrigger
                                                                tabIndex={-1}>
                                                                <Info
                                                                    size={14}
                                                                    className="text-primary-light cursor-help"
                                                                />
                                                            </TooltipTrigger>
                                                            <TooltipContent
                                                                align="start"
                                                                className="flex flex-col gap-0.5 font-mono text-xs">
                                                                {(
                                                                    directory.folders ??
                                                                    []
                                                                ).map(
                                                                    (folder) => (
                                                                        <span
                                                                            key={
                                                                                folder.id
                                                                            }>
                                                                            {
                                                                                folder.path
                                                                            }
                                                                        </span>
                                                                    ),
                                                                )}
                                                            </TooltipContent>
                                                        </Tooltip>
                                                    </span>
                                                </FormControl.Helper>
                                            ) : (
                                                <FormControl.Helper>
                                                    If empty, rule will be
                                                    applied to all files.
                                                </FormControl.Helper>
                                            )}
                                        </div>
                                    </FormControl.Input>
                                </div>
                            );
                        }}
                    />

                    {rule?.sourcePath && (
                        <div className="grid grid-cols-[1fr_3fr] gap-6">
                            <FormControl.Root>
                                <FormControl.Label className="mb-0 flex flex-row gap-1">
                                    Source
                                </FormControl.Label>

                                <FormControl.Helper>
                                    Readonly. This Kody {entityLabel} was
                                    created based on this file.
                                </FormControl.Helper>
                            </FormControl.Root>

                            <FormControl.Input>
                                <Input value={rule?.sourcePath} disabled />
                            </FormControl.Input>
                        </div>
                    )}

                    <Controller
                        name="rule"
                        control={form.control}
                        rules={{ required: "Instructions are required" }}
                        render={({ field, fieldState }) => (
                            <div className="grid grid-cols-[1fr_3fr] gap-6">
                                <FormControl.Root>
                                    <FormControl.Label
                                        className="mb-0 flex flex-row gap-1"
                                        htmlFor={field.name}>
                                        Instructions
                                        <Tooltip>
                                            <TooltipTrigger tabIndex={-1}>
                                                <HelpCircle
                                                    size={16}
                                                    className="text-primary-light"
                                                />
                                            </TooltipTrigger>

                                            <TooltipContent
                                                align="start"
                                                className="flex max-w-prose flex-col gap-1 text-xs">
                                                <p>
                                                    Describe what Kody should
                                                    focus on during the review.
                                                </p>
                                                <p>
                                                    Use variables like{" "}
                                                    <code className="text-primary-light">
                                                        {"{{pr.body}}"}
                                                    </code>{" "}
                                                    or{" "}
                                                    <code className="text-primary-light">
                                                        {"{{file.path}}"}
                                                    </code>{" "}
                                                    to reference dynamic
                                                    context.
                                                </p>
                                                <p>
                                                    Reference files from any
                                                    connected repository using{" "}
                                                    <code className="text-primary-light">
                                                        @repo/path/to/file
                                                    </code>
                                                </p>
                                            </TooltipContent>
                                        </Tooltip>
                                    </FormControl.Label>
                                    <FormControl.Helper>
                                        Provide guidelines for{" "}
                                        {entityLabel.toLowerCase()} behavior
                                    </FormControl.Helper>
                                </FormControl.Root>

                                <FormControl.Input>
                                    <div className="flex flex-col gap-2">
                                        <RichTextEditorWithMentions
                                            ref={editorRef}
                                            value={field.value || ""}
                                            onChangeAction={(value) =>
                                                field.onChange(
                                                    typeof value === "string"
                                                        ? value
                                                        : "",
                                                )
                                            }
                                            disabled={field.disabled}
                                            placeholder={
                                                INSTRUCTIONS_PLACEHOLDER
                                            }
                                            saveFormat="text"
                                            groups={[]}
                                            className="min-h-32"
                                            toolbarExtraActions={
                                                !isMemory ? (
                                                    <Popover>
                                                        <PopoverTrigger
                                                            asChild>
                                                            <Button
                                                                size="xs"
                                                                variant="cancel"
                                                                type="button"
                                                                disabled={
                                                                    field.disabled
                                                                }
                                                                className="h-7 gap-1"
                                                                rightIcon={
                                                                    <ChevronDown className="size-3" />
                                                                }
                                                                leftIcon={
                                                                    <Code2 className="size-3" />
                                                                }>
                                                                Variables
                                                            </Button>
                                                        </PopoverTrigger>
                                                        <PopoverContent
                                                            align="end"
                                                            className="w-72 p-3">
                                                            <div className="flex flex-col gap-3">
                                                                <span className="text-text-primary text-xs font-medium">
                                                                    {watchScope ===
                                                                        "file"
                                                                        ? "File context"
                                                                        : "PR context"}
                                                                </span>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    {(watchScope ===
                                                                        "file"
                                                                        ? FILE_CONTEXT_VARIABLES
                                                                        : PR_CONTEXT_VARIABLES
                                                                    ).map(
                                                                        (
                                                                            v,
                                                                        ) => (
                                                                            <button
                                                                                key={
                                                                                    v.key
                                                                                }
                                                                                type="button"
                                                                                className="bg-primary-dark text-primary-light rounded px-2 py-1 font-mono text-xs transition-all hover:brightness-125"
                                                                                onClick={() => {
                                                                                    editorRef.current?.insertText(
                                                                                        v.label,
                                                                                    );
                                                                                    editorRef.current?.focus();
                                                                                }}>
                                                                                {
                                                                                    v.label
                                                                                }
                                                                            </button>
                                                                        ),
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </PopoverContent>
                                                    </Popover>
                                                ) : undefined
                                            }
                                        />

                                        <FormControl.Error>
                                            {fieldState.error?.message}
                                        </FormControl.Error>

                                        {!rule && !isMemory && (
                                            <RuleSuggestions
                                                currentValue={field.value || ""}
                                                onSelectSuggestion={(
                                                    suggestionRule,
                                                ) => {
                                                    field.onChange(
                                                        suggestionRule,
                                                    );
                                                    editorRef.current?.focus();
                                                }}
                                                disabled={field.disabled}
                                            />
                                        )}

                                        <ExternalReferencesDisplay
                                            externalReferences={{
                                                references:
                                                    rule?.externalReferences ||
                                                    [],
                                                syncErrors:
                                                    rule?.syncErrors ||
                                                    (rule?.syncError
                                                        ? [rule.syncError]
                                                        : []),
                                                processingStatus:
                                                    rule?.referenceProcessingStatus ||
                                                    "completed",
                                            }}
                                            compact
                                        />
                                    </div>
                                </FormControl.Input>
                            </div>
                        )}
                    />

                    <Controller
                        name="severity"
                        control={form.control}
                        render={({ field, fieldState }) => {
                            if (isMemory) return <></>;

                            return (
                                <div className="grid grid-cols-[1fr_3fr] gap-6">
                                    <FormControl.Root>
                                        <FormControl.Label
                                            className="flex flex-row gap-1"
                                            htmlFor={field.name}>
                                            Severity
                                            <Tooltip>
                                                <TooltipTrigger tabIndex={-1}>
                                                    <HelpCircle
                                                        size={16}
                                                        className="text-primary-light"
                                                    />
                                                </TooltipTrigger>

                                                <TooltipContent
                                                    align="start"
                                                    className="flex max-w-prose flex-col gap-1 text-xs">
                                                    <p>
                                                        Severity defines how
                                                        this rule&apos;s
                                                        violations will be
                                                        classified in code
                                                        reviews.
                                                    </p>

                                                    <ul className="flex flex-col gap-1">
                                                        <li>
                                                            <strong className="text-info">
                                                                Low:
                                                            </strong>{" "}
                                                            Minor improvements
                                                            and low-risk issues.
                                                        </li>
                                                        <li>
                                                            <strong className="text-alert">
                                                                Medium:
                                                            </strong>{" "}
                                                            Recommended fixes
                                                            that improve
                                                            correctness or
                                                            quality.
                                                        </li>
                                                        <li>
                                                            <strong className="text-warning">
                                                                High:
                                                            </strong>{" "}
                                                            Important problems
                                                            that should be fixed
                                                            in the PR.
                                                        </li>
                                                        <li>
                                                            <strong className="text-danger">
                                                                Critical:
                                                            </strong>{" "}
                                                            Severe bugs,
                                                            security
                                                            vulnerabilities, or
                                                            data loss risks.
                                                        </li>
                                                    </ul>
                                                </TooltipContent>
                                            </Tooltip>
                                        </FormControl.Label>
                                        <FormControl.Helper>
                                            Choose how violations will be
                                            classified
                                        </FormControl.Helper>
                                    </FormControl.Root>

                                    <FormControl.Input>
                                        <div className="flex flex-col gap-3">
                                            <div className="relative w-full max-w-md">
                                                <SliderWithMarkers
                                                    id={field.name}
                                                    min={0}
                                                    max={3}
                                                    step={1}
                                                    labels={Object.values(
                                                        severitySliderOptions,
                                                    ).map(
                                                        (option) =>
                                                            option.label,
                                                    )}
                                                    value={
                                                        severitySliderOptions[
                                                            field.value ??
                                                            "high"
                                                        ]?.value ?? 2
                                                    }
                                                    disabled={field.disabled}
                                                    onValueChange={(value) =>
                                                        field.onChange(
                                                            Object.entries(
                                                                severitySliderOptions,
                                                            ).find(
                                                                ([, option]) =>
                                                                    option.value ===
                                                                    value,
                                                            )?.[0] ?? "high",
                                                        )
                                                    }
                                                    className={cn({
                                                        "[--slider-marker-background-active:var(--color-info)]":
                                                            field.value ===
                                                            "low",
                                                        "[--slider-marker-background-active:var(--color-alert)]":
                                                            field.value ===
                                                            "medium",
                                                        "[--slider-marker-background-active:var(--color-warning)]":
                                                            field.value ===
                                                            "high",
                                                        "[--slider-marker-background-active:var(--color-danger)]":
                                                            field.value ===
                                                            "critical",
                                                    })}
                                                />
                                            </div>

                                            <p className="text-text-secondary text-sm">
                                                {
                                                    severityOptions.find(
                                                        (option) =>
                                                            option.value ===
                                                            field.value,
                                                    )?.description
                                                }
                                            </p>

                                            <FormControl.Error>
                                                {fieldState.error?.message}
                                            </FormControl.Error>
                                        </div>
                                    </FormControl.Input>
                                </div>
                            );
                        }}
                    />

                    <Collapsible>
                        <CollapsibleTrigger asChild>
                            <button
                                type="button"
                                className="text-text-secondary hover:text-text-primary flex w-full items-center gap-2 py-2 text-sm transition-colors">
                                <Settings2 className="size-4" />
                                <span>Advanced settings</span>
                                <CollapsibleIndicator className="ml-auto" />
                            </button>
                        </CollapsibleTrigger>

                        <CollapsibleContent className="flex flex-col gap-6 pt-4">
                            <Controller
                                name="inheritable"
                                control={form.control}
                                render={({ field }) => (
                                    <div className="grid grid-cols-[1fr_3fr] gap-6">
                                        <FormControl.Root>
                                            <FormControl.Label className="mb-0 flex flex-row gap-1">
                                                Inheritable
                                                <Tooltip>
                                                    <TooltipTrigger tabIndex={-1}>
                                                        <HelpCircle
                                                            size={16}
                                                            className="text-primary-light"
                                                        />
                                                    </TooltipTrigger>
                                                    <TooltipContent
                                                        align="start"
                                                        className="flex max-w-prose flex-col gap-1 text-xs">
                                                        <p>
                                                            When enabled, this
                                                            {entityLabel.toLowerCase()}{" "}
                                                            can be inherited by
                                                            lower scopes.
                                                        </p>
                                                        <p>
                                                            If disabled, the
                                                            {entityLabel.toLowerCase()}{" "}
                                                            will only apply to
                                                            the current scope.
                                                        </p>
                                                    </TooltipContent>
                                                </Tooltip>
                                            </FormControl.Label>
                                            <FormControl.Helper>
                                                Allow lower scopes to inherit
                                            </FormControl.Helper>
                                        </FormControl.Root>
                                        <FormControl.Input>
                                            <Switch
                                                id={field.name}
                                                disabled={field.disabled}
                                                onCheckedChange={field.onChange}
                                                checked={field.value}
                                            />
                                        </FormControl.Input>
                                    </div>
                                )}
                            />

                            {!isMemory && (
                                <>
                                    <Separator />

                                    <div className="flex flex-col gap-4">
                                        <span className="text-text-secondary text-sm font-medium">
                                            Code examples
                                        </span>

                                        <Controller
                                            control={form.control}
                                            name="badExample"
                                            render={({ field, fieldState }) => (
                                                <div className="grid grid-cols-[1fr_3fr] gap-6">
                                                    <FormControl.Root>
                                                        <FormControl.Label
                                                            className="mb-0 flex flex-row gap-1"
                                                            htmlFor={
                                                                field.name
                                                            }>
                                                            <div className="flex items-center gap-3">
                                                                <div
                                                                    className={cn(
                                                                        "bg-danger/10 flex size-6 items-center justify-center rounded-full",
                                                                    )}>
                                                                    <XIcon className="stroke-danger size-4" />
                                                                </div>
                                                                <span className="text-sm font-medium">
                                                                    Bad example
                                                                </span>
                                                            </div>
                                                        </FormControl.Label>
                                                    </FormControl.Root>

                                                    <FormControl.Input>
                                                        <div>
                                                            <CodeInputSimple
                                                                value={
                                                                    field.value ||
                                                                    ""
                                                                }
                                                                onChangeAction={(
                                                                    value,
                                                                ) =>
                                                                    field.onChange(
                                                                        value,
                                                                    )
                                                                }
                                                                disabled={
                                                                    field.disabled
                                                                }
                                                                language="javascript"
                                                            />

                                                            <FormControl.Error>
                                                                {
                                                                    fieldState
                                                                        .error
                                                                        ?.message
                                                                }
                                                            </FormControl.Error>
                                                        </div>
                                                    </FormControl.Input>
                                                </div>
                                            )}
                                        />

                                        <Controller
                                            control={form.control}
                                            name="goodExample"
                                            render={({ field, fieldState }) => (
                                                <div className="grid grid-cols-[1fr_3fr] gap-6">
                                                    <FormControl.Root>
                                                        <FormControl.Label
                                                            className="mb-0 flex flex-row gap-1"
                                                            htmlFor={
                                                                field.name
                                                            }>
                                                            <div className="flex items-center gap-3">
                                                                <div
                                                                    className={cn(
                                                                        "bg-success/10 flex size-6 items-center justify-center rounded-full",
                                                                    )}>
                                                                    <CheckIcon className="stroke-success size-4" />
                                                                </div>
                                                                <span className="text-sm font-medium">
                                                                    Good example
                                                                </span>
                                                            </div>
                                                        </FormControl.Label>
                                                    </FormControl.Root>

                                                    <FormControl.Input>
                                                        <div>
                                                            <CodeInputSimple
                                                                value={
                                                                    field.value ||
                                                                    ""
                                                                }
                                                                onChangeAction={(
                                                                    value,
                                                                ) =>
                                                                    field.onChange(
                                                                        value,
                                                                    )
                                                                }
                                                                disabled={
                                                                    field.disabled
                                                                }
                                                                language="javascript"
                                                            />

                                                            <FormControl.Error>
                                                                {
                                                                    fieldState
                                                                        .error
                                                                        ?.message
                                                                }
                                                            </FormControl.Error>
                                                        </div>
                                                    </FormControl.Input>
                                                </div>
                                            )}
                                        />
                                    </div>
                                </>
                            )}
                        </CollapsibleContent>
                    </Collapsible>
                </div>

                <DialogFooter className="mt-0">
                    <Button
                        variant="cancel"
                        size="md"
                        onClick={() => {
                            if (onClose) {
                                onClose();
                            } else {
                                magicModal.hide();
                            }
                        }}>
                        Cancel
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        loading={formState.isSubmitting}
                        onClick={handleSubmit}
                        leftIcon={rule ? <SaveIcon /> : <PlusIcon />}
                        disabled={
                            formState.disabled ||
                            !formState.isValid ||
                            !formState.isDirty
                        }>
                        {rule
                            ? `Update ${entityLabel.toLowerCase()}`
                            : `Create ${entityLabel.toLowerCase()}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
