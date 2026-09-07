"use client";

import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Button } from "@components/ui/button";
import { Keycap } from "@components/ui/keycap";
import { ScrollArea } from "@components/ui/scroll-area";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetFooter,
    SheetHeader,
    SheetTitle,
} from "@components/ui/sheet";
import { SyntaxHighlight } from "@components/ui/syntax-highlight";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useAsyncAction } from "@hooks/use-async-action";
import { useShortcut } from "@hooks/use-shortcut";
import {
    KodyRulesStatus,
    KodyRulesType,
    resolveKodyRuleDisplaySeverity,
    type KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";
import {
    ArrowDownIcon,
    ArrowRightToLineIcon,
    ArrowUpIcon,
    CheckIcon,
    EditIcon,
    EyeIcon,
    FileCodeIcon,
    FolderIcon,
    GitPullRequestIcon,
    LayersIcon,
    PauseIcon,
    PlayIcon,
    SparklesIcon,
    TrashIcon,
    XIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";

import { ExternalReferencesDisplay } from "../../pr-summary/_components/external-references-display";
import {
    formatAbsoluteDate,
    RuleStatus,
    type KodyRuleRowContext,
    type KodyRulesTableVariant,
} from "./data-table-row";
import { OriginBadge } from "./origin-badge";
import { RuleImpact } from "./rule-impact";

type RuleDetailSheetProps = {
    /** The rule to show; null keeps the sheet closed. */
    rule: KodyRuleWithInheritanceDetails | null;
    variant: KodyRulesTableVariant;
    syncEnabledForRepo?: boolean;
    context: KodyRuleRowContext;
    onClose: () => void;
    /** Step to the previous / next rule in the list currently on screen. */
    onNavigate: (delta: -1 | 1) => void;
    hasPrevious: boolean;
    hasNext: boolean;
};

/**
 * Rule detail as a right-hand sheet — the same pattern the Issues page uses.
 * Non-modal on purpose: the table stays clickable, so picking another row
 * swaps the content, and J / K (or the arrows) walk the list. The sheet
 * only repeats what the row can't show: the full instructions, the
 * examples, references and the few facts the row truncates.
 */
export const KodyRuleDetailSheet = ({
    rule,
    variant,
    syncEnabledForRepo,
    context,
    onClose,
    onNavigate,
    hasPrevious,
    hasNext,
}: RuleDetailSheetProps) => {
    const open = !!rule;
    useShortcut("j", () => onNavigate(1), { enabled: open && hasNext });
    useShortcut("k", () => onNavigate(-1), { enabled: open && hasPrevious });

    const [changeStatus, { loading: isChangingStatus }] = useAsyncAction(
        (status: KodyRulesStatus.ACTIVE | KodyRulesStatus.PAUSED) =>
            rule ? context.onChangeStatus(rule, status) : Promise.resolve(),
    );

    if (!rule) return null;

    const isMemory =
        variant === "memories" ||
        (rule.type ?? KodyRulesType.STANDARD) === KodyRulesType.MEMORY;
    const entityLabel = isMemory ? "memory" : "rule";
    const isInherited = !!rule.inherited;
    const isPaused = rule.status === KodyRulesStatus.PAUSED;
    const canMutate = context.canEdit && !isInherited;
    const examples = Array.isArray(rule.examples) ? rule.examples : [];
    const references = rule.externalReferences ?? [];
    const syncErrors = Array.isArray(rule.syncErrors) ? rule.syncErrors : [];
    const updated = formatAbsoluteDate(rule.updatedAt ?? rule.createdAt);

    return (
        <Sheet modal={false} open>
            <SheetContent
                className="gap-0 py-0 sm:max-w-2xl"
                onEscapeKeyDown={onClose}
                // Non-modal: clicks on the table must reach the rows.
                onInteractOutside={(event) => event.preventDefault()}>
                <SheetHeader className="border-card-lv3/60 gap-3 border-b px-6 pt-4 pb-5">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1">
                            <Button
                                size="sm"
                                variant="cancel"
                                className="p-0"
                                aria-label="Close"
                                onClick={onClose}>
                                <ArrowRightToLineIcon />
                                <Keycap>Esc</Keycap>
                            </Button>
                            <span
                                aria-hidden
                                className="bg-card-lv3 mx-2 h-4 w-px"
                            />
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger asChild>
                                    <Button
                                        size="icon-sm"
                                        variant="helper"
                                        aria-label="Next rule"
                                        disabled={!hasNext}
                                        onClick={() => onNavigate(1)}>
                                        <ArrowDownIcon />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <Keycap>J</Keycap> next {entityLabel}
                                </TooltipContent>
                            </Tooltip>
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger asChild>
                                    <Button
                                        size="icon-sm"
                                        variant="helper"
                                        aria-label="Previous rule"
                                        disabled={!hasPrevious}
                                        onClick={() => onNavigate(-1)}>
                                        <ArrowUpIcon />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <Keycap>K</Keycap> previous {entityLabel}
                                </TooltipContent>
                            </Tooltip>
                        </div>

                        {/* Signals only: severity (the one coloured thing)
                            and enforcement state. Provenance lives in the
                            metadata line under the title. */}
                        <div className="flex items-center gap-2">
                            {!isMemory && (
                                <IssueSeverityLevelBadge
                                    severity={resolveKodyRuleDisplaySeverity(
                                        rule,
                                    )}
                                />
                            )}
                            <RuleStatus
                                rule={rule}
                                isFreePlan={context.isFreePlan}
                                entityLabel={entityLabel}
                            />
                        </div>
                    </div>

                    <div className="flex flex-col gap-2">
                        <SheetTitle className="text-xl leading-snug text-balance">
                            {rule.title}
                        </SheetTitle>
                        <SheetDescription asChild>
                            <div className="text-text-secondary flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                                {!isMemory && (
                                    <OriginBadge
                                        rule={rule}
                                        syncEnabledForRepo={syncEnabledForRepo}
                                        variant="text"
                                    />
                                )}
                                {isMemory ? (
                                    <span className="flex items-center gap-1">
                                        <SparklesIcon className="size-3 shrink-0" />
                                        All prompts and conversations
                                    </span>
                                ) : (
                                    <span className="flex min-w-0 items-center gap-1">
                                        <FolderIcon className="size-3 shrink-0" />
                                        <code className="font-mono break-all">
                                            {rule.path || "all files"}
                                        </code>
                                    </span>
                                )}
                                {!isMemory && rule.scope === "pull-request" && (
                                    <span className="flex items-center gap-1">
                                        <GitPullRequestIcon className="size-3 shrink-0" />
                                        PR-level
                                    </span>
                                )}
                                {rule.sourcePath && (
                                    <span className="flex min-w-0 items-center gap-1">
                                        <FileCodeIcon className="size-3 shrink-0" />
                                        <code className="font-mono break-all">
                                            {rule.sourcePath}
                                        </code>
                                    </span>
                                )}
                                {isInherited && (
                                    <span className="flex items-center gap-1">
                                        <LayersIcon className="size-3 shrink-0" />
                                        inherited from {rule.inherited}
                                        {rule.excluded && ", disabled here"}
                                    </span>
                                )}
                                {updated && (
                                    <span title="Last change">
                                        updated {updated}
                                    </span>
                                )}
                            </div>
                        </SheetDescription>
                    </div>
                </SheetHeader>

                <ScrollArea className="min-h-0 flex-1">
                    <div className="flex flex-col gap-8 px-6 py-6">
                        {/* The instructions ARE the rule: body copy, readable
                            measure, no label — the title above names it. */}
                        <p className="text-text-primary max-w-prose text-[15px] leading-relaxed whitespace-pre-wrap">
                            {rule.rule}
                        </p>

                        {!isMemory && (
                            <RuleImpact
                                rule={rule}
                                seeAll={context.renderSuggestions?.(rule)}
                            />
                        )}

                        {/* Stacked, never side by side: code needs the full
                            width so indentation survives, and it scrolls
                            sideways rather than wrapping. */}
                        {examples.length > 0 && (
                            <div className="flex flex-col gap-4">
                                {examples.map((example, index) => (
                                    <figure
                                        key={index}
                                        className="flex min-w-0 flex-col gap-2">
                                        <figcaption
                                            className={cn(
                                                "flex items-center gap-1.5 text-xs font-semibold",
                                                example.isCorrect
                                                    ? "text-success"
                                                    : "text-danger",
                                            )}>
                                            {example.isCorrect ? (
                                                <CheckIcon className="size-3.5" />
                                            ) : (
                                                <XIcon className="size-3.5" />
                                            )}
                                            {example.isCorrect ? "Good" : "Bad"}
                                        </figcaption>
                                        <SyntaxHighlight
                                            language="typescript"
                                            wrap={false}
                                            className="text-xs"
                                            contentStyle={{
                                                margin: 0,
                                                padding: "0.75rem 1rem",
                                                borderRadius: "0.5rem",
                                                background:
                                                    "var(--color-card-lv1)",
                                            }}>
                                            {example.snippet}
                                        </SyntaxHighlight>
                                    </figure>
                                ))}
                            </div>
                        )}

                        {(references.length > 0 || syncErrors.length > 0) && (
                            <ExternalReferencesDisplay
                                externalReferences={{
                                    references,
                                    syncErrors,
                                    processingStatus:
                                        rule.referenceProcessingStatus ||
                                        "completed",
                                }}
                            />
                        )}

                        {rule.centralizedConfig && (
                            <p className="text-text-tertiary text-xs">
                                Managed by{" "}
                                <code className="font-mono">
                                    {rule.centralizedConfig.path}
                                </code>
                                {rule.centralizedConfig.status !== "synced" &&
                                    ` (${rule.centralizedConfig.status.replace("_", " ")})`}
                            </p>
                        )}
                    </div>
                </ScrollArea>

                <SheetFooter className="border-card-lv3/60 mt-0 flex-row items-center justify-end gap-3 border-t px-6 py-4">
                    <div className="flex items-center gap-2">
                        {!isInherited && (
                            <Button
                                size="sm"
                                variant="helper"
                                disabled={!context.canEdit || isChangingStatus}
                                loading={isChangingStatus}
                                leftIcon={
                                    isPaused ? <PlayIcon /> : <PauseIcon />
                                }
                                onClick={() =>
                                    changeStatus(
                                        isPaused
                                            ? KodyRulesStatus.ACTIVE
                                            : KodyRulesStatus.PAUSED,
                                    )
                                }>
                                {isPaused ? "Resume" : "Pause"}
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant={canMutate ? "primary" : "helper"}
                            leftIcon={canMutate ? <EditIcon /> : <EyeIcon />}
                            onClick={() => context.onOpenRule(rule)}>
                            {canMutate ? "Edit" : "View"}
                        </Button>
                        {!isInherited && (
                            <Button
                                size="icon-sm"
                                variant="cancel"
                                aria-label={"Delete " + entityLabel}
                                title="Delete"
                                disabled={!context.canDelete}
                                className="[--button-foreground:var(--color-danger)]"
                                onClick={() => context.onDeleteRule(rule)}>
                                <TrashIcon />
                            </Button>
                        )}
                    </div>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    );
};
