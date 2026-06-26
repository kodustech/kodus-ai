"use client";

import { useState } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
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
import { ChevronDownIcon } from "lucide-react";
import PierreDiff from "src/app/(app)/pull-requests/[repositoryId]/[prNumber]/_components/pierre-diff";

import { getCentralizedPrToastPayload } from "../../../_utils/centralized-pr-feedback";
import { OriginBadge } from "./origin-badge";

const isMemory = (rule: KodyRule) =>
    (rule.type ?? KodyRulesType.STANDARD) === KodyRulesType.MEMORY;

const isUpdateRequest = (rule: KodyRule) =>
    rule.requestType === KodyRuleRequestType.UPDATE;

const entityNoun = (rule: KodyRule) => (isMemory(rule) ? "memory" : "rule");

// Flatten an item's editable fields into one document so a proposed change
// renders as a single before/after diff.
const buildDiffDoc = (item: KodyRule) =>
    `Title: ${item.title ?? ""}\nPath: ${item.path ?? ""}\n\n${item.rule ?? ""}`;

const Header = ({
    rule,
    title,
    update,
    selection,
}: {
    rule: KodyRule;
    title: string;
    update?: boolean;
    selection?: { isSelected: boolean; onToggle: () => void };
}) => (
    <CardHeader className="flex flex-row items-center gap-3 px-5 py-4">
        {selection && (
            <input
                type="checkbox"
                checked={selection.isSelected}
                onChange={selection.onToggle}
                aria-label={"Select " + (title || entityNoun(rule))}
                className="border-card-lv3 bg-card-lv2 accent-primary-light size-4 cursor-pointer rounded border"
            />
        )}

        <span className="flex-1 truncate font-medium">{title}</span>

        <div className="flex items-center gap-3">
            <OriginBadge rule={rule} />
            {!isMemory(rule) && (
                <IssueSeverityLevelBadge severity={rule.severity} />
            )}
            {update && (
                <Badge active size="xs" className="min-h-auto">
                    Update
                </Badge>
            )}
            <CollapsibleTrigger asChild>
                <Button active size="icon-sm" variant="helper">
                    <CollapsibleIndicator />
                </Button>
            </CollapsibleTrigger>
        </div>
    </CardHeader>
);

/**
 * Pending items for the current tab, rendered inline above the active list and
 * visually distinct. Create-requests offer approve / discard; update-requests
 * show a diff against the rule/memory they target and offer "update existing",
 * "create new instead", or discard. Renders nothing when there's nothing
 * pending.
 */
export const PendingSection = ({
    pendingRules,
    activeRules,
    entityLabel,
    teamId,
    canEdit,
    refreshRulesList,
}: {
    pendingRules: KodyRule[];
    activeRules: KodyRule[];
    entityLabel: "rules" | "memories";
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

    const toggleSelection = (id: string) =>
        setSelection((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    // Only act on items that are both selected and currently shown — keeps the
    // bulk action honest when the selection survives a filter switch.
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

    const cardSelection = (r: KodyRule) =>
        canEdit && r.uuid
            ? {
                  isSelected: selection.has(r.uuid),
                  onToggle: () => toggleSelection(r.uuid!),
              }
            : undefined;

    return (
        <div className="border-warning/30 bg-warning/5 flex w-full flex-col gap-2 rounded-lg border border-dashed p-3">
            <div className="flex items-center gap-2 px-1 pb-1">
                <span className="text-text-primary text-sm font-semibold">
                    Pending review
                </span>
                <Badge active size="xs" className="min-h-auto">
                    {pendingRules.length}
                </Badge>
                <span className="text-text-secondary text-xs">
                    Generated, imported, and proposed {entityLabel} awaiting
                    approval.
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
                            className="bg-card-lv1 ring-card-lv2 flex flex-wrap items-center gap-3 rounded-lg px-3 py-1.5 ring-1"
                            role="toolbar"
                            aria-label="Pending bulk actions">
                            <span className="text-text-secondary text-xs tabular-nums">
                                <strong className="text-text-primary">
                                    {selectedShown.length}
                                </strong>{" "}
                                selected
                            </span>

                            <div className="bg-card-lv2 h-4 w-px" aria-hidden />

                            {!allSelected && (
                                <Button
                                    size="xs"
                                    variant="cancel"
                                    onClick={() =>
                                        setSelection(new Set(allSelectableIds))
                                    }>
                                    Select all ({allSelectableIds.length})
                                </Button>
                            )}
                            <Button
                                size="xs"
                                variant="cancel"
                                disabled={selectedShown.length === 0}
                                onClick={() => setSelection(new Set())}>
                                Clear
                            </Button>

                            <div className="flex-1" />

                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button
                                        size="xs"
                                        variant="primary"
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

                    <div className="flex max-h-[480px] flex-col gap-2 overflow-y-auto pr-1">
                        {pendingRules.map((r) => {
                            if (!r.uuid) return null;

                            if (isUpdateRequest(r)) {
                                const target = r.targetRuleUuid
                                    ? targetsById.get(r.targetRuleUuid)
                                    : undefined;

                                return (
                                    <Card key={r.uuid} className="shrink-0">
                                        <Collapsible className="w-full">
                                            <Header
                                                rule={r}
                                                title={target?.title || r.title}
                                                update
                                                selection={cardSelection(r)}
                                            />
                                            <CollapsibleContent
                                                asChild
                                                className="pb-0">
                                                <CardContent className="bg-card-lv1 flex flex-col gap-4 pt-4">
                                                    {!target ? (
                                                        <div className="text-warning text-sm">
                                                            Target{" "}
                                                            {entityNoun(r)} was
                                                            not found in the
                                                            current list —
                                                            review carefully.
                                                        </div>
                                                    ) : (
                                                        <PierreDiff
                                                            fileName={
                                                                target.title ||
                                                                entityNoun(r)
                                                            }
                                                            oldCode={buildDiffDoc(
                                                                target,
                                                            )}
                                                            newCode={buildDiffDoc(
                                                                r,
                                                            )}
                                                            diffStyle="unified"
                                                        />
                                                    )}

                                                    <div className="flex flex-wrap justify-end gap-2 pt-2">
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
                                                            onClick={() =>
                                                                discard(r)
                                                            }>
                                                            Discard
                                                        </Button>
                                                        <Button
                                                            size="sm"
                                                            variant="primary"
                                                            disabled={!canEdit}
                                                            onClick={() =>
                                                                approve(r)
                                                            }>
                                                            Update existing
                                                        </Button>
                                                    </div>
                                                </CardContent>
                                            </CollapsibleContent>
                                        </Collapsible>
                                    </Card>
                                );
                            }

                            // Create-request — a brand-new rule/memory, nothing to diff.
                            return (
                                <Card key={r.uuid} className="shrink-0">
                                    <Collapsible className="w-full">
                                        <Header
                                            rule={r}
                                            title={r.title}
                                            selection={cardSelection(r)}
                                        />
                                        <CollapsibleContent
                                            asChild
                                            className="pb-0">
                                            <CardContent className="bg-card-lv1 flex flex-col gap-5 pt-4">
                                                <Markdown>{r.rule}</Markdown>

                                                <div className="flex flex-wrap justify-end gap-2">
                                                    <Button
                                                        size="sm"
                                                        variant="cancel"
                                                        disabled={!canEdit}
                                                        onClick={() =>
                                                            discard(r)
                                                        }>
                                                        Discard
                                                    </Button>
                                                    <Button
                                                        size="sm"
                                                        variant="primary"
                                                        disabled={!canEdit}
                                                        onClick={() =>
                                                            approve(r)
                                                        }>
                                                        Approve
                                                    </Button>
                                                </div>
                                            </CardContent>
                                        </CollapsibleContent>
                                    </Collapsible>
                                </Card>
                            );
                        })}
                    </div>
                </>
            )}
        </div>
    );
};
