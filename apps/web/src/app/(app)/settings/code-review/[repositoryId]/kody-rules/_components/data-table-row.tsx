"use client";

import {
    useEffect,
    useState,
    type ReactNode,
    type SyntheticEvent,
} from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { KodyRulesLimitPopover } from "@components/system/kody-rules-limit-popover";
import { Button } from "@components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { PopoverTrigger } from "@components/ui/popover";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useAsyncAction } from "@hooks/use-async-action";
import {
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
    KodyRulesType,
    resolveKodyRuleDisplaySeverity,
    type KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";
import {
    AlertTriangleIcon,
    ClockIcon,
    EditIcon,
    EllipsisIcon,
    EyeIcon,
    FileCodeIcon,
    FolderIcon,
    GitPullRequestIcon,
    LayersIcon,
    LinkIcon,
    LockIcon,
    PauseIcon,
    PlayIcon,
    SparklesIcon,
    TrashIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import { isOrphanAutoSyncRule } from "src/core/utils/kody-rules/apply-filters";
import { inferRuleOrigin } from "src/core/utils/kody-rules/infer-origin";
import { resolveKodyRuleBadgeState } from "src/core/utils/kody-rules/resolve-badge-state";
import type { KodyRuleHealthRow } from "src/features/ee/cockpit/_services/analytics/review/fetch";

import { OriginBadge } from "./origin-badge";
import { ATTENTION_STATES, RuleHealthChip } from "./rule-health";

export type KodyRulesTableVariant = "rules" | "memories";

/**
 * Everything a row needs from the page that is NOT derived from the rule
 * itself: permissions, plan, and the imperative actions (modals, status
 * changes). Built once by the page and shared by every row and by the
 * detail sheet, so the table stays presentational — it never reaches into
 * route params, config contexts or permission hooks on its own.
 */
export type KodyRuleRowContext = {
    canEdit: boolean;
    canDelete: boolean;
    isFreePlan: boolean;
    /** Opens the edit (or read-only) modal for the rule. */
    onOpenRule: (rule: KodyRuleWithInheritanceDetails) => void | Promise<void>;
    /** Opens the delete confirmation for the rule. */
    onDeleteRule: (
        rule: KodyRuleWithInheritanceDetails,
    ) => void | Promise<void>;
    /** Pauses / resumes one rule. Resolves once the list has refreshed. */
    onChangeStatus: (
        rule: KodyRuleWithInheritanceDetails,
        status: KodyRulesStatus.ACTIVE | KodyRulesStatus.PAUSED,
    ) => Promise<void>;
    /** Trigger to the full list of suggestions this rule produced. */
    renderSuggestions?: (rule: KodyRuleWithInheritanceDetails) => ReactNode;
    /**
     * Cockpit health by rule uuid (see `useKodyRulesHealth`). When present the
     * rules table grows a Usage column; `null`/absent hides it entirely.
     */
    health?: Map<string, KodyRuleHealthRow> | null;
};

// Shared column template for the rows AND the table header (data-table.tsx)
// so the two stay aligned. Fixed trailing columns; the identity column
// flexes and wraps. Columns (rules, wide tier — container ≥ 56rem):
//   [checkbox] | rule (grows) | severity | origin | status | updated | actions
// Below that (settings page + sidebar on a laptop) the Origin and Updated
// columns fold into the identity subline so the title keeps enough room:
//   [checkbox] | rule (grows) | severity | status | actions
// Memories drop severity + origin (they have neither). The checkbox column
// only exists when bulk selection is wired, so read-only views don't pay
// for an empty track. Every literal must stay spelled out for Tailwind.
export const getKodyRulesRowGrid = (
    variant: KodyRulesTableVariant,
    withSelection: boolean,
    withUsage = false,
) => {
    if (variant === "memories") {
        return cn(
            "grid items-center gap-x-3",
            withSelection
                ? "grid-cols-[1.25rem_minmax(0,1fr)_6.5rem_4.5rem_4rem]"
                : "grid-cols-[minmax(0,1fr)_6.5rem_4.5rem_4rem]",
        );
    }
    // Rules. With usage: … | severity | origin | usage | status | updated | …
    if (withUsage) {
        return cn(
            "grid items-center gap-x-3",
            withSelection
                ? "grid-cols-[1.25rem_minmax(0,1fr)_5rem_7rem_6.5rem_4rem] @4xl:grid-cols-[1.25rem_minmax(0,1fr)_5rem_7.5rem_7rem_6.5rem_4.5rem_4rem]"
                : "grid-cols-[minmax(0,1fr)_5rem_7rem_6.5rem_4rem] @4xl:grid-cols-[minmax(0,1fr)_5rem_7.5rem_7rem_6.5rem_4.5rem_4rem]",
        );
    }
    return cn(
        "grid items-center gap-x-3",
        withSelection
            ? "grid-cols-[1.25rem_minmax(0,1fr)_5rem_6.5rem_4rem] @4xl:grid-cols-[1.25rem_minmax(0,1fr)_5rem_7.5rem_6.5rem_4.5rem_4rem]"
            : "grid-cols-[minmax(0,1fr)_5rem_6.5rem_4rem] @4xl:grid-cols-[minmax(0,1fr)_5rem_7.5rem_6.5rem_4.5rem_4rem]",
    );
};

export function showLastPaths(path: string, max = 3): string {
    const items = path
        .split(",")
        .map((g) => g.trim())
        .filter((g) => g.length > 0);
    if (items.length <= max) return path;
    return "..." + items.slice(-max).join(", ");
}

export const formatAbsoluteDate = (value?: string | null) => {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
};

// "2m ago" / "3h ago" / "5d ago": the column is narrow and the exact
// timestamp is one hover away (title attribute).
const formatCompactAgo = (date: Date) => {
    const minutes = Math.floor(
        Math.max(0, Date.now() - date.getTime()) / 60_000,
    );
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
};

// Deferred on purpose: relative time reads `new Date()`, so computing it
// during render would hydration-mismatch. First paint shows nothing, the
// client swaps in "3 days ago" after mount (same trick as the PR list).
export const TimeAgo = ({ date }: { date?: string | null }) => {
    const [label, setLabel] = useState<string | null>(null);

    useEffect(() => {
        if (!date) return;
        const parsed = new Date(date);
        if (Number.isNaN(parsed.getTime())) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLabel(formatCompactAgo(parsed));
    }, [date]);

    if (!date || !label) {
        return (
            <span className="text-text-tertiary" aria-label="Unknown">
                &mdash;
            </span>
        );
    }

    return (
        <span
            title={formatAbsoluteDate(date) ?? undefined}
            className="cursor-default tabular-nums">
            {label}
        </span>
    );
};

// One quiet form for every enforcement state — a coloured dot and a word —
// so the column reads as a status list, not a row of alerts. Colour carries
// the meaning: green enforced, amber paused, blue awaiting a centralized
// change, grey disabled.
const STATUS_DOT_TONES = {
    success: "bg-success",
    warning: "bg-warning",
    info: "bg-info",
    muted: "bg-text-tertiary",
} as const;

export const StatusPill = ({
    tone,
    label,
    title,
}: {
    tone: keyof typeof STATUS_DOT_TONES;
    label: string;
    title: string;
}) => (
    <span
        title={title}
        className="text-text-secondary inline-flex items-center gap-1.5 text-xs">
        <span
            aria-hidden
            className={cn(
                "size-1.5 shrink-0 rounded-full",
                STATUS_DOT_TONES[tone],
            )}
        />
        {label}
    </span>
);

/** Enforcement state of a rule, shared by the row and the detail sheet. */
export const centralizedPendingLabel = (
    rule: KodyRuleWithInheritanceDetails,
) =>
    rule.centralizedConfig?.status === KodyRuleCentralizedStatus.PENDING_ADD
        ? "Pending add"
        : rule.centralizedConfig?.status ===
            KodyRuleCentralizedStatus.PENDING_DELETE
          ? "Pending delete"
          : rule.centralizedConfig?.status ===
              KodyRuleCentralizedStatus.PENDING_EDIT
            ? "Pending edit"
            : null;

export const RuleStatus = ({
    rule,
    isFreePlan,
    entityLabel,
}: {
    rule: KodyRuleWithInheritanceDetails;
    isFreePlan: boolean;
    entityLabel: string;
}) => {
    const isInherited = !!rule.inherited;
    const isExcluded = isInherited && !!rule.excluded;
    const isPaused = rule.status === KodyRulesStatus.PAUSED;
    const isLockedByPlan =
        resolveKodyRuleBadgeState(rule, isFreePlan) === "locked";
    const pending = centralizedPendingLabel(rule);
    const stop = (event: SyntheticEvent) => event.stopPropagation();

    if (isLockedByPlan) {
        // Same form as the other states; the lock stands in for the dot and
        // the label opens the plan-limit popover.
        return (
            <span onClick={stop} className="inline-flex">
                <KodyRulesLimitPopover limit={10}>
                    <PopoverTrigger asChild>
                        <button
                            type="button"
                            title={`Locked by the Free plan cap: this ${entityLabel} stays in your list but is skipped on every new PR.`}
                            className="text-primary-light hover:text-primary-light/80 inline-flex cursor-pointer items-center gap-1.5 text-xs">
                            <LockIcon aria-hidden className="size-3 shrink-0" />
                            Locked
                        </button>
                    </PopoverTrigger>
                </KodyRulesLimitPopover>
            </span>
        );
    }
    if (isPaused) {
        return (
            <StatusPill
                tone="warning"
                label="Paused"
                title={`This ${entityLabel} is paused: it stays in your list but is skipped on every new PR.`}
            />
        );
    }
    if (isExcluded) {
        return (
            <StatusPill
                tone="muted"
                label="Disabled"
                title={`This ${entityLabel} is inherited but disabled for this scope.`}
            />
        );
    }
    if (pending) {
        return (
            <StatusPill
                tone="info"
                label={pending}
                title={`This ${entityLabel} has a pending centralized configuration change.`}
            />
        );
    }
    return (
        <StatusPill
            tone="success"
            label="Active"
            title="Enforced on every new PR"
        />
    );
};

type KodyRuleRowProps = {
    rule: KodyRuleWithInheritanceDetails;
    variant: KodyRulesTableVariant;
    /** Whether the table reserves the checkbox column (header decides). */
    withSelection: boolean;
    /** Per-row selection wiring; `eligible: false` renders an empty slot. */
    selection?: {
        isSelected: boolean;
        eligible: boolean;
        onToggle: () => void;
    };
    /** Repo's `ideRulesSyncEnabled`; forwarded to OriginBadge + row accent. */
    syncEnabledForRepo?: boolean;
    /** The rule currently open in the detail sheet. */
    active: boolean;
    /** Row click: open this rule in the detail sheet. */
    onSelect: () => void;
    context: KodyRuleRowContext;
};

export const KodyRuleRow = ({
    rule,
    variant,
    withSelection,
    selection,
    syncEnabledForRepo,
    active,
    onSelect,
    context,
}: KodyRuleRowProps) => {
    const isMemory =
        variant === "memories" ||
        (rule.type ?? KodyRulesType.STANDARD) === KodyRulesType.MEMORY;
    const isInherited = !!rule.inherited;
    const isExcluded = isInherited && !!rule.excluded;
    const isPaused = rule.status === KodyRulesStatus.PAUSED;
    const entityLabel = isMemory ? "memory" : "rule";
    const canMutate = context.canEdit && !isInherited;
    const syncErrors = Array.isArray(rule.syncErrors) ? rule.syncErrors : [];
    const hasSyncErrors = syncErrors.length > 0;
    const isOrphan =
        !isMemory && syncEnabledForRepo === false && isOrphanAutoSyncRule(rule);
    const references = rule.externalReferences ?? [];
    const origin = inferRuleOrigin(rule);
    const withUsage = variant === "rules" && !!context.health;
    const healthRow = rule.uuid ? context.health?.get(rule.uuid) : undefined;
    const isEnforced = !isPaused && !isExcluded;

    const [changeStatus, { loading: isChangingStatus }] = useAsyncAction(
        (status: KodyRulesStatus.ACTIVE | KodyRulesStatus.PAUSED) =>
            context.onChangeStatus(rule, status),
    );

    // Status cue on the row's leading edge, so a broken reference sync or an
    // orphaned auto-sync rule is caught on the first downward scan. Every
    // other state keeps a transparent edge so the list stays quiet.
    const rowAccent = hasSyncErrors
        ? "border-l-danger/70"
        : isOrphan
          ? "border-l-warning/70"
          : "border-l-transparent";

    const stop = (event: SyntheticEvent) => event.stopPropagation();

    return (
        <div
            className={cn("border-card-lv3/30 border-b border-l-2", rowAccent)}>
            <div
                role="button"
                tabIndex={0}
                aria-pressed={active}
                onClick={onSelect}
                onKeyDown={(event) => {
                    // Only the row itself opens the sheet; keys inside the
                    // checkbox / action buttons keep their native meaning.
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onSelect();
                }}
                className={cn(
                    "cursor-pointer px-4 py-2.5",
                    getKodyRulesRowGrid(variant, withSelection, withUsage),
                    active
                        ? "bg-card-lv2/50 hover:bg-card-lv2/60"
                        : "hover:bg-card-lv1/70",
                )}>
                {withSelection && (
                    <div className="flex items-center" onClick={stop}>
                        {selection?.eligible ? (
                            <input
                                type="checkbox"
                                checked={selection.isSelected}
                                onChange={selection.onToggle}
                                aria-label={
                                    "Select " +
                                    entityLabel +
                                    " " +
                                    (rule.title ?? "")
                                }
                                className="border-card-lv3 bg-card-lv2 accent-primary-light size-4 cursor-pointer rounded border"
                            />
                        ) : (
                            <span aria-hidden className="size-4" />
                        )}
                    </div>
                )}

                {/* Identity column: title + a metadata subline (path · source ·
                    scope · inheritance · references). Keeps the card richness
                    inside one aligned table column. */}
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                        <span
                            title={rule.title}
                            className={cn(
                                "line-clamp-2 min-w-0 text-sm font-semibold break-words",
                                isEnforced
                                    ? "text-text-primary"
                                    : "text-text-secondary",
                            )}>
                            {rule.title}
                        </span>
                        {hasSyncErrors && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span className="text-danger flex shrink-0 items-center">
                                        <AlertTriangleIcon className="size-3.5" />
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-xs">
                                    {syncErrors.length === 1
                                        ? "1 reference failed to sync."
                                        : `${syncErrors.length} references failed to sync.`}{" "}
                                    Open the rule for details.
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>

                    <div className="text-text-secondary mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                        {isMemory ? (
                            <span className="flex items-center gap-1">
                                <SparklesIcon className="size-3 shrink-0" />
                                All prompts and conversations
                            </span>
                        ) : rule.path ? (
                            <Tooltip delayDuration={400}>
                                <TooltipTrigger asChild>
                                    <span className="flex max-w-[22rem] min-w-0 items-center gap-1">
                                        <FolderIcon className="size-3 shrink-0" />
                                        <span className="truncate font-mono">
                                            {showLastPaths(rule.path)}
                                        </span>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent
                                    side="bottom"
                                    className="max-w-96 text-xs">
                                    <code className="font-mono break-all">
                                        {rule.path}
                                    </code>
                                </TooltipContent>
                            </Tooltip>
                        ) : (
                            <span
                                title="No path filter: the rule applies to every changed file"
                                className="flex items-center gap-1">
                                <FolderIcon className="size-3 shrink-0" />
                                all files
                            </span>
                        )}

                        {!isMemory && rule.scope === "pull-request" && (
                            <span
                                title="Evaluated once against the whole pull request, not per file"
                                className="flex items-center gap-1">
                                <GitPullRequestIcon className="size-3 shrink-0" />
                                PR-level
                            </span>
                        )}

                        {rule.sourcePath && (
                            <span
                                title={"Imported from " + rule.sourcePath}
                                className="flex max-w-[16rem] min-w-0 items-center gap-1">
                                <FileCodeIcon className="size-3 shrink-0" />
                                <span className="truncate font-mono">
                                    {rule.sourcePath}
                                </span>
                            </span>
                        )}

                        {isInherited && (
                            <span
                                title={`Inherited from the ${rule.inherited} scope. It can be viewed here but only edited at its own scope.`}
                                className="flex items-center gap-1">
                                <LayersIcon className="size-3 shrink-0" />
                                from {rule.inherited}
                            </span>
                        )}

                        {/* Compact tier only: the Origin and Updated columns
                            are hidden, so their content rides along here. */}
                        {!isMemory && origin !== "manual" && (
                            <OriginBadge
                                rule={rule}
                                syncEnabledForRepo={syncEnabledForRepo}
                                variant="text"
                                className="@4xl:hidden"
                            />
                        )}
                        {!isMemory && (
                            <span className="flex items-center gap-1 @4xl:hidden">
                                <ClockIcon className="size-3 shrink-0" />
                                <TimeAgo
                                    date={rule.updatedAt ?? rule.createdAt}
                                />
                            </span>
                        )}

                        {references.length > 0 && (
                            <span
                                title="External references attached to this rule"
                                className="flex items-center gap-1 tabular-nums">
                                <LinkIcon className="size-3 shrink-0" />
                                {references.length}{" "}
                                {references.length === 1
                                    ? "reference"
                                    : "references"}
                            </span>
                        )}
                    </div>
                </div>

                {!isMemory && (
                    <div className="flex min-w-0 items-center">
                        <IssueSeverityLevelBadge
                            severity={resolveKodyRuleDisplaySeverity(rule)}
                        />
                    </div>
                )}

                {!isMemory && (
                    <div className="hidden min-w-0 items-center @4xl:flex">
                        <OriginBadge
                            rule={rule}
                            syncEnabledForRepo={syncEnabledForRepo}
                            variant="text"
                        />
                    </div>
                )}

                {/* Usage column (Cockpit tiers with warehouse data only):
                    triggers in the health window, when it last fired, and a
                    chip for the states that need attention. Paused / pending
                    rules are not measured, so they show a dash. */}
                {withUsage && (
                    <div className="flex min-w-0 flex-col gap-0.5 text-xs">
                        {healthRow ? (
                            <>
                                <span className="flex items-center gap-1.5">
                                    <span className="text-text-primary font-medium tabular-nums">
                                        {healthRow.triggers}
                                    </span>
                                    {ATTENTION_STATES.has(healthRow.state) && (
                                        <RuleHealthChip
                                            state={healthRow.state}
                                        />
                                    )}
                                </span>
                                <span className="text-text-secondary truncate">
                                    {healthRow.lastTriggeredAt ? (
                                        <>
                                            last{" "}
                                            <TimeAgo
                                                date={healthRow.lastTriggeredAt}
                                            />
                                        </>
                                    ) : (
                                        "never fired"
                                    )}
                                </span>
                            </>
                        ) : (
                            <span
                                className="text-text-secondary"
                                title="No usage data — only active rules are measured.">
                                —
                            </span>
                        )}
                    </div>
                )}

                {/* Status column: enforcement state. Loud pills are reserved
                    for the states that need attention (locked / paused /
                    disabled / pending); a healthy rule is a quiet green dot. */}
                <div className="flex min-w-0 items-center">
                    <RuleStatus
                        rule={rule}
                        isFreePlan={context.isFreePlan}
                        entityLabel={entityLabel}
                    />
                </div>

                <div
                    className={cn(
                        "text-text-secondary min-w-0 text-xs",
                        !isMemory && "hidden @4xl:block",
                    )}>
                    <TimeAgo date={rule.updatedAt ?? rule.createdAt} />
                </div>

                {/* Actions: primary (edit / view) stays visible; the rest lives
                    behind an overflow menu so the row keeps a table rhythm. */}
                <div
                    className="flex items-center justify-end gap-0.5"
                    onClick={stop}>
                    <Button
                        size="icon-xs"
                        variant="cancel"
                        aria-label={
                            canMutate
                                ? "Edit " + entityLabel
                                : "View " + entityLabel + " details"
                        }
                        title={canMutate ? "Edit" : "View details"}
                        onClick={() => context.onOpenRule(rule)}>
                        {canMutate ? (
                            <EditIcon aria-hidden />
                        ) : (
                            <EyeIcon aria-hidden />
                        )}
                    </Button>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="icon-xs"
                                variant="cancel"
                                aria-label="More actions"
                                title="More actions">
                                <EllipsisIcon aria-hidden />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {isPaused && !isInherited && (
                                <DropdownMenuItem
                                    disabled={
                                        !context.canEdit || isChangingStatus
                                    }
                                    onSelect={() =>
                                        changeStatus(KodyRulesStatus.ACTIVE)
                                    }>
                                    <PlayIcon className="size-4" aria-hidden />
                                    Resume
                                </DropdownMenuItem>
                            )}
                            {!isPaused && !isInherited && (
                                <DropdownMenuItem
                                    disabled={
                                        !context.canEdit || isChangingStatus
                                    }
                                    onSelect={() =>
                                        changeStatus(KodyRulesStatus.PAUSED)
                                    }>
                                    <PauseIcon className="size-4" aria-hidden />
                                    Pause
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                                onSelect={() => context.onOpenRule(rule)}>
                                {canMutate ? (
                                    <EditIcon className="size-4" aria-hidden />
                                ) : (
                                    <EyeIcon className="size-4" aria-hidden />
                                )}
                                {canMutate ? "Edit" : "View details"}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                disabled={!context.canDelete || isInherited}
                                className="[--button-foreground:var(--color-danger)]"
                                onSelect={() => context.onDeleteRule(rule)}>
                                <TrashIcon className="size-4" aria-hidden />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </div>
    );
};
