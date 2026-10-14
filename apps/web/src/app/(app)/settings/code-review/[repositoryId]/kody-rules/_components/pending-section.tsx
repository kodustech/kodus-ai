"use client";

import { useState } from "react";
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
import { Markdown } from "@components/ui/markdown";
import { toast } from "@components/ui/toaster/use-toast";
import {
    applyPendingKodyRules,
    convertPendingUpdatesToNew,
    discardPendingKodyRules,
} from "@services/kodyRules/fetch";
import {
    KodyRule,
    KodyRuleRequestType,
    KodyRulesType,
} from "@services/kodyRules/types";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { ArrowRightIcon, ChevronDownIcon } from "lucide-react";
import PierreDiff from "src/app/(app)/pull-requests/[repositoryId]/[prNumber]/_components/pierre-diff";
import { cn } from "src/core/utils/components";

import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import { OriginBadge } from "./origin-badge";

// How many items the block shows before "See all" — enough to see what is
// waiting without pushing the active list below the fold.
const PREVIEW_COUNT = 3;

type PendingKind = "rule" | "memory" | "update";

const KIND_CHIP: Record<PendingKind, { label: string; className: string }> = {
    rule: { label: "Rule", className: "bg-card-lv2 text-text-secondary" },
    memory: { label: "Memory", className: "bg-card-lv2 text-text-secondary" },
    update: { label: "Update", className: "bg-warning/15 text-warning" },
};

const isMemory = (rule: KodyRule) =>
    (rule.type ?? KodyRulesType.STANDARD) === KodyRulesType.MEMORY;

const isUpdateRequest = (rule: KodyRule) =>
    rule.requestType === KodyRuleRequestType.UPDATE;

const kindOf = (rule: KodyRule): PendingKind =>
    isUpdateRequest(rule) ? "update" : isMemory(rule) ? "memory" : "rule";

const entityNoun = (rule: KodyRule) => (isMemory(rule) ? "memory" : "rule");

// Flatten an item's editable fields into one document so a proposed change
// renders as a single before/after diff.
const buildDiffDoc = (item: KodyRule) =>
    `Title: ${item.title ?? ""}\nPath: ${item.path ?? ""}\n\n${item.rule ?? ""}`;

const KindChip = ({ kind }: { kind: PendingKind }) => (
    <span
        className={cn(
            "inline-flex h-5 shrink-0 items-center rounded px-1.5 text-xs font-semibold tracking-wide uppercase",
            KIND_CHIP[kind].className,
        )}>
        {KIND_CHIP[kind].label}
    </span>
);

const PendingRow = ({
    rule,
    title,
    selection,
    children,
}: {
    rule: KodyRule;
    title: string;
    selection?: { isSelected: boolean; onToggle: () => void };
    children: React.ReactNode;
}) => (
    <Collapsible className="group/collapsible">
        <div className="flex items-center gap-3 px-3 py-2">
            {selection && (
                <input
                    type="checkbox"
                    checked={selection.isSelected}
                    onChange={selection.onToggle}
                    aria-label={"Select " + (title || entityNoun(rule))}
                    className="border-card-lv3 bg-card-lv2 accent-primary-light size-4 shrink-0 cursor-pointer rounded border"
                />
            )}

            <KindChip kind={kindOf(rule)} />

            <CollapsibleTrigger asChild>
                <button
                    type="button"
                    className="hover:text-primary-light flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className="text-text-primary min-w-0 flex-1 truncate text-sm">
                        {title || `Untitled ${entityNoun(rule)}`}
                    </span>

                    <span className="text-text-secondary hidden shrink-0 items-center gap-1.5 text-xs sm:flex">
                        <OriginBadge rule={rule} variant="text" />
                        {!isMemory(rule) && rule.severity && (
                            <>
                                <span aria-hidden>·</span>
                                <span className="font-medium uppercase">
                                    {rule.severity}
                                </span>
                            </>
                        )}
                    </span>

                    <CollapsibleIndicator />
                </button>
            </CollapsibleTrigger>
        </div>

        <CollapsibleContent className="pb-0">
            <div className="border-card-lv3/60 flex flex-col gap-4 border-t px-4 py-4">
                {children}
            </div>
        </CollapsibleContent>
    </Collapsible>
);

/**
 * Everything waiting for approval in this scope — generated, imported and
 * proposed rules and memories — in one block above the tabs. Create-requests
 * offer approve / discard; update-requests show a diff against the item they
 * target and offer "update existing", "create new instead", or discard. Shows
 * the first few and expands on demand. Renders nothing when nothing is pending.
 */
export const PendingSection = ({
    pendingRules,
    activeRules,
    teamId,
    canEdit,
    refreshRulesList,
}: {
    pendingRules: KodyRule[];
    activeRules: KodyRule[];
    teamId: string;
    canEdit: boolean;
    refreshRulesList: () => void;
}) => {
    const targetsById = new Map(
        activeRules.filter((r) => r.uuid).map((r) => [r.uuid, r]),
    );

    const run = async (
        action: () => Promise<unknown>,
        centralizedMessage: string,
    ) => {
        try {
            const response = await action();
            if (isCentralizedPrResponse(response)) {
                toast(
                    getCentralizedPrToastPayload(response, centralizedMessage),
                );
            }
        } catch (error) {
            console.error("Error processing pending item:", error);
            toast({
                title: "Error",
                description: "Could not process the pending item.",
                variant: "danger",
            });
        } finally {
            refreshRulesList();
        }
    };

    const approve = (r: KodyRule) =>
        run(
            () => applyPendingKodyRules(teamId, [r.uuid!]),
            "Change proposed through centralized pull request.",
        );

    const discard = (r: KodyRule) =>
        run(
            () => discardPendingKodyRules(teamId, [r.uuid!]),
            "Discard proposed through centralized pull request.",
        );

    const createInstead = (r: KodyRule) =>
        run(
            () => convertPendingUpdatesToNew(teamId, [r.uuid!]),
            "New item proposed through centralized pull request.",
        );

    const [selection, setSelection] = useState<Set<string>>(new Set());
    const [collapsed, setCollapsed] = useState(false);
    const [showAll, setShowAll] = useState(false);

    const toggleSelection = (id: string) =>
        setSelection((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // Only act on items that are both selected and currently pending — keeps
    // the bulk action honest when the selection outlives a refresh.
    const selectedShown = pendingRules.filter(
        (r) => r.uuid && selection.has(r.uuid),
    );
    const selectedIds = selectedShown.map((r) => r.uuid!);
    const selectedUpdateIds = selectedShown
        .filter(isUpdateRequest)
        .map((r) => r.uuid!);

    const runBulk = async (
        action: () => Promise<unknown>,
        centralizedMessage: string,
    ) => {
        await run(action, centralizedMessage);
        setSelection(new Set());
    };

    const bulkApprove = () =>
        runBulk(
            () => applyPendingKodyRules(teamId, selectedIds),
            "Changes proposed through centralized pull request.",
        );

    const bulkDiscard = () =>
        runBulk(
            () => discardPendingKodyRules(teamId, selectedIds),
            "Discards proposed through centralized pull request.",
        );

    const bulkCreateNew = () =>
        runBulk(
            () => convertPendingUpdatesToNew(teamId, selectedUpdateIds),
            "New items proposed through centralized pull request.",
        );

    if (pendingRules.length === 0) {
        return null;
    }

    const allSelectableIds = pendingRules
        .filter((r) => r.uuid)
        .map((r) => r.uuid!);
    const allSelected =
        selectedIds.length > 0 && selectedIds.length >= allSelectableIds.length;

    const rowSelection = (r: KodyRule) =>
        canEdit && r.uuid
            ? {
                  isSelected: selection.has(r.uuid),
                  onToggle: () => toggleSelection(r.uuid!),
              }
            : undefined;

    const total = pendingRules.length;
    const hasMore = total > PREVIEW_COUNT;
    const visible = showAll
        ? pendingRules
        : pendingRules.slice(0, PREVIEW_COUNT);

    return (
        <section
            aria-label="Pending review"
            className="border-warning/30 bg-warning/5 flex w-full flex-col gap-3 rounded-xl border border-dashed p-4">
            <div className="flex items-center gap-2">
                <span className="text-text-primary text-sm font-semibold">
                    Pending review
                </span>
                <span className="bg-warning/15 text-warning inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-semibold tabular-nums">
                    {total}
                </span>
                <span className="text-text-secondary hidden text-xs sm:inline">
                    Rules and memories awaiting approval.
                </span>
                <div className="flex-1" />
                <Button
                    size="xs"
                    variant="cancel"
                    onClick={() => setCollapsed((c) => !c)}
                    rightIcon={
                        <ChevronDownIcon
                            className={collapsed ? "" : "rotate-180"}
                            aria-hidden
                        />
                    }>
                    {collapsed ? "Show" : "Hide"}
                </Button>
            </div>

            {!collapsed && (
                <>
                    {canEdit && (
                        <div
                            className="text-text-secondary flex flex-wrap items-center gap-x-1 gap-y-1 text-xs"
                            role="toolbar"
                            aria-label="Pending bulk actions">
                            <span className="tabular-nums">
                                <strong className="text-text-primary font-semibold">
                                    {selectedShown.length}
                                </strong>{" "}
                                selected
                            </span>
                            <span aria-hidden>·</span>
                            <Button
                                size="xs"
                                variant="cancel"
                                className="h-auto min-h-0 px-1 py-0"
                                disabled={allSelected}
                                onClick={() =>
                                    setSelection(new Set(allSelectableIds))
                                }>
                                Select all ({allSelectableIds.length})
                            </Button>
                            <span aria-hidden>·</span>
                            <Button
                                size="xs"
                                variant="cancel"
                                className="h-auto min-h-0 px-1 py-0"
                                disabled={selectedShown.length === 0}
                                onClick={() => setSelection(new Set())}>
                                Clear
                            </Button>

                            <div className="flex-1" />

                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        size="xs"
                                        variant="helper"
                                        className="ring-1"
                                        disabled={selectedShown.length === 0}
                                        rightIcon={
                                            <ChevronDownIcon aria-hidden />
                                        }>
                                        Bulk actions
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={bulkApprove}>
                                        Approve {selectedShown.length}
                                    </DropdownMenuItem>
                                    {selectedUpdateIds.length > 0 && (
                                        <DropdownMenuItem
                                            onClick={bulkCreateNew}>
                                            Create as new (
                                            {selectedUpdateIds.length})
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={bulkDiscard}>
                                        Discard {selectedShown.length}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    )}

                    <div className="border-card-lv3/60 bg-card-lv1 divide-card-lv3/60 flex flex-col divide-y overflow-hidden rounded-lg border">
                        {visible.map((r) => {
                            if (!r.uuid) return null;

                            if (isUpdateRequest(r)) {
                                const target = r.targetRuleUuid
                                    ? targetsById.get(r.targetRuleUuid)
                                    : undefined;

                                return (
                                    <PendingRow
                                        key={r.uuid}
                                        rule={r}
                                        title={target?.title || r.title}
                                        selection={rowSelection(r)}>
                                        {!target ? (
                                            <div className="text-warning text-sm">
                                                Target {entityNoun(r)} was not
                                                found in the current list —
                                                review carefully.
                                            </div>
                                        ) : (
                                            <PierreDiff
                                                fileName={
                                                    target.title ||
                                                    entityNoun(r)
                                                }
                                                oldCode={buildDiffDoc(target)}
                                                newCode={buildDiffDoc(r)}
                                                diffStyle="unified"
                                            />
                                        )}

                                        <div className="flex flex-wrap justify-end gap-2">
                                            <Button
                                                size="sm"
                                                variant="helper"
                                                disabled={!canEdit}
                                                onClick={() =>
                                                    createInstead(r)
                                                }>
                                                Create new instead
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="cancel"
                                                disabled={!canEdit}
                                                onClick={() => discard(r)}>
                                                Discard
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="primary"
                                                disabled={!canEdit}
                                                onClick={() => approve(r)}>
                                                Update existing
                                            </Button>
                                        </div>
                                    </PendingRow>
                                );
                            }

                            // Create-request — a brand-new rule/memory, nothing to diff.
                            return (
                                <PendingRow
                                    key={r.uuid}
                                    rule={r}
                                    title={r.title}
                                    selection={rowSelection(r)}>
                                    <Markdown>{r.rule}</Markdown>

                                    <div className="flex flex-wrap justify-end gap-2">
                                        <Button
                                            size="sm"
                                            variant="cancel"
                                            disabled={!canEdit}
                                            onClick={() => discard(r)}>
                                            Discard
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            disabled={!canEdit}
                                            onClick={() => approve(r)}>
                                            Approve
                                        </Button>
                                    </div>
                                </PendingRow>
                            );
                        })}
                    </div>

                    {hasMore && (
                        <Button
                            size="xs"
                            variant="cancel"
                            className="self-center"
                            onClick={() => setShowAll((v) => !v)}
                            rightIcon={
                                showAll ? undefined : (
                                    <ArrowRightIcon aria-hidden />
                                )
                            }>
                            {showAll
                                ? `Show first ${PREVIEW_COUNT}`
                                : `See all ${total} pending items`}
                        </Button>
                    )}
                </>
            )}
        </section>
    );
};
