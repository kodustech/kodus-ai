"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    KodyRulesStatus,
    type KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";
import { ArrowDownIcon, ChevronsUpDownIcon } from "lucide-react";
import { cn } from "src/core/utils/components";
import type { SortOption } from "src/core/utils/kody-rules/apply-filters";

import {
    getKodyRulesRowGrid,
    KodyRuleRow,
    type KodyRuleRowContext,
    type KodyRulesTableVariant,
} from "./data-table-row";

type HeaderCellProps = {
    label: string;
    hint: string;
    /** When set, the header is a button that applies this sort option. */
    sort?: {
        active: boolean;
        onSort: () => void;
    };
};

// Column label with an explanation on hover. Sortable headers double as the
// sort control: the page keeps ONE sort option (recent / severity /
// alphabetical) shared with the Filters popover, so clicking a header
// selects that option rather than toggling asc/desc per column.
const HeaderCell = ({ label, hint, sort }: HeaderCellProps) => {
    const content = sort ? (
        <button
            type="button"
            onClick={sort.onSort}
            aria-pressed={sort.active}
            className={cn(
                "hover:text-text-primary flex w-fit items-center gap-1 uppercase transition-colors focus:outline-none focus-visible:underline",
                sort.active && "text-text-primary",
            )}>
            {label}
            {sort.active ? (
                <ArrowDownIcon className="size-3" aria-hidden />
            ) : (
                <ChevronsUpDownIcon className="size-3 opacity-50" aria-hidden />
            )}
        </button>
    ) : (
        <span className="w-fit cursor-help">{label}</span>
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>{content}</TooltipTrigger>
            <TooltipContent
                side="bottom"
                className="max-w-xs text-xs normal-case">
                {hint}
            </TooltipContent>
        </Tooltip>
    );
};

type KodyRulesDataTableProps = {
    rules: KodyRuleWithInheritanceDetails[];
    variant: KodyRulesTableVariant;
    context: KodyRuleRowContext;
    /** Repo's `ideRulesSyncEnabled`; forwarded to each row. */
    syncEnabledForRepo?: boolean;
    /** Rule open in the detail sheet (highlighted row). */
    activeRuleId?: string | null;
    /** Row click → open in the detail sheet. */
    onSelectRule: (rule: KodyRuleWithInheritanceDetails) => void;
    sortOption: SortOption;
    onSortOptionChange: (option: SortOption) => void;
    /** Optional bulk-selection wiring. When omitted there is no checkbox
     *  column at all. */
    bulkSelection?: {
        selection: ReadonlySet<string>;
        onToggle: (ruleId: string) => void;
        isEligible: (rule: KodyRuleWithInheritanceDetails) => boolean;
        onSelectAll: () => void;
        onClear: () => void;
    };
    /** Rendered INSIDE the sticky header, replacing the column labels,
     *  while at least one row is selected — the header turns into the
     *  action bar instead of a second sticky strip fighting for `top-0`. */
    bulkToolbar?: ReactNode;
};

export const KodyRulesDataTable = ({
    rules,
    variant,
    context,
    syncEnabledForRepo,
    activeRuleId,
    onSelectRule,
    sortOption,
    onSortOptionChange,
    bulkSelection,
    bulkToolbar,
}: KodyRulesDataTableProps) => {
    const withSelection = !!bulkSelection;
    const withUsage = variant === "rules" && !!context.health;
    const grid = getKodyRulesRowGrid(variant, withSelection, withUsage);

    const eligibleCount = bulkSelection
        ? rules.filter((rule) => rule.uuid && bulkSelection.isEligible(rule))
              .length
        : 0;
    const selectedCount = bulkSelection?.selection.size ?? 0;
    const allSelected = eligibleCount > 0 && selectedCount >= eligibleCount;
    const someSelected = selectedCount > 0 && !allSelected;

    // `indeterminate` is a DOM property, not an attribute — set it by hand.
    const headerCheckboxRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (headerCheckboxRef.current) {
            headerCheckboxRef.current.indeterminate = someSelected;
        }
    }, [someSelected]);

    const pausedCount = rules.filter(
        (rule) => rule.status === KodyRulesStatus.PAUSED,
    ).length;
    const singular = variant === "memories" ? "memory" : "rule";
    const plural = variant === "memories" ? "memories" : "rules";
    const showBulkToolbar = selectedCount > 0 && !!bulkToolbar;

    return (
        // `@container` lets the column set follow the TABLE's width (not the
        // viewport): with the settings sidebar open on a laptop the wide tier
        // would crush the title column, so Origin/Updated fold into the row
        // below 56rem (see getKodyRulesRowGrid).
        <div className="border-card-lv3/60 bg-card-lv1 @container overflow-clip rounded-xl border">
            {/* Narrow containers scroll the grid sideways; wide ones keep the
                page-level sticky header (no scroll container in between). */}
            <div className="@max-2xl:overflow-x-auto">
                <div className="@max-2xl:min-w-[40rem]">
                    {/* Sticky header — sticks to the page scroller (overflow-clip
                above does not create a scroll container, so `top-0` still
                means the top of the page). Labels the aligned columns each
                row lays out via getKodyRulesRowGrid. Fully opaque on
                purpose: rows scroll underneath it, and a translucent
                surface let their text bleed through the labels. */}
                    <div className="border-card-lv3/40 bg-card-lv1 sticky top-0 z-10 border-b">
                        {showBulkToolbar ? (
                            bulkToolbar
                        ) : (
                            <div
                                className={cn(
                                    grid,
                                    "text-text-secondary text-2xs px-4 py-2.5 font-medium tracking-wide uppercase",
                                )}>
                                {withSelection && (
                                    <div className="flex items-center">
                                        <input
                                            ref={headerCheckboxRef}
                                            type="checkbox"
                                            checked={allSelected}
                                            disabled={eligibleCount === 0}
                                            onChange={() =>
                                                allSelected
                                                    ? bulkSelection?.onClear()
                                                    : bulkSelection?.onSelectAll()
                                            }
                                            aria-label={
                                                allSelected
                                                    ? "Clear selection"
                                                    : `Select all ${eligibleCount} selectable ${plural}`
                                            }
                                            className="border-card-lv3 bg-card-lv2 accent-primary-light size-4 cursor-pointer rounded border disabled:cursor-not-allowed disabled:opacity-40"
                                        />
                                    </div>
                                )}
                                <HeaderCell
                                    label={
                                        variant === "memories"
                                            ? "Memory"
                                            : "Rule"
                                    }
                                    hint="Title, target path, source file and where it is inherited from. Click a row to open the rule."
                                    sort={{
                                        active: sortOption === "alphabetical",
                                        onSort: () =>
                                            onSortOptionChange("alphabetical"),
                                    }}
                                />
                                {variant === "rules" && (
                                    <HeaderCell
                                        label="Severity"
                                        hint="How loud Kody is when this rule is broken."
                                        sort={{
                                            active:
                                                sortOption === "severity-desc",
                                            onSort: () =>
                                                onSortOptionChange(
                                                    "severity-desc",
                                                ),
                                        }}
                                    />
                                )}
                                {variant === "rules" && (
                                    <div className="hidden @4xl:block">
                                        <HeaderCell
                                            label="Origin"
                                            hint="Where the rule came from: written by hand, the rule library, onboarding analysis, IDE auto-sync, Kody-generated, CLI or an MCP agent."
                                        />
                                    </div>
                                )}
                                {withUsage && (
                                    <HeaderCell
                                        label="Usage"
                                        hint="Times the rule fired in the last 30 days and when it last did. Noisy, ignored and stale rules get a chip; healthy ones stay quiet."
                                    />
                                )}
                                <HeaderCell
                                    label="Status"
                                    hint="Active rules run on every new PR. Paused, locked and disabled rules stay listed but are skipped."
                                />
                                <div
                                    className={cn(
                                        variant === "rules" &&
                                            "hidden @4xl:block",
                                    )}>
                                    <HeaderCell
                                        label="Updated"
                                        hint="Last time the rule changed."
                                        sort={{
                                            active: sortOption === "recent",
                                            onSort: () =>
                                                onSortOptionChange("recent"),
                                        }}
                                    />
                                </div>
                                <span aria-hidden />
                            </div>
                        )}
                    </div>

                    <div>
                        {rules.map((rule, index) => (
                            <KodyRuleRow
                                key={rule.uuid ?? index}
                                rule={rule}
                                variant={variant}
                                withSelection={withSelection}
                                selection={
                                    bulkSelection && rule.uuid
                                        ? {
                                              isSelected:
                                                  bulkSelection.selection.has(
                                                      rule.uuid,
                                                  ),
                                              eligible:
                                                  bulkSelection.isEligible(
                                                      rule,
                                                  ),
                                              onToggle: () =>
                                                  bulkSelection.onToggle(
                                                      rule.uuid as string,
                                                  ),
                                          }
                                        : undefined
                                }
                                syncEnabledForRepo={syncEnabledForRepo}
                                active={
                                    !!rule.uuid && rule.uuid === activeRuleId
                                }
                                onSelect={() => onSelectRule(rule)}
                                context={context}
                            />
                        ))}
                    </div>

                    <div className="text-text-tertiary flex items-center gap-3 px-4 py-2 text-xs tabular-nums">
                        <span>
                            {rules.length}{" "}
                            {rules.length === 1 ? singular : plural}
                        </span>
                        {pausedCount > 0 && (
                            <>
                                <span aria-hidden>·</span>
                                <span>{pausedCount} paused</span>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
