"use client";

import { KodyRulesLimitPopover } from "@components/system/kody-rules-limit-popover";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { magicModal } from "@components/ui/magic-modal";
import { PopoverTrigger } from "@components/ui/popover";
import { Section } from "@components/ui/section";
import { Separator } from "@components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipPortal,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    KodyRuleCentralizedStatus,
    KodyRulesType,
    resolveKodyRuleDisplaySeverity,
    type KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { EditIcon, EyeIcon, LockIcon, PlayIcon, TrashIcon } from "lucide-react";
import { SuggestionsModal } from "src/app/(app)/library/kody-rules/_components/suggestions-modal";

import { OriginBadge } from "./origin-badge";

import { DeleteKodyRuleConfirmationModal } from "../../../_components/delete-confirmation-modal";
import { KodyRuleAddOrUpdateItemModal } from "../../../_components/modal";
import { useFullCodeReviewConfig } from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";
import { ExternalReferencesDisplay } from "../../pr-summary/_components/external-references-display";
import { changeStatusKodyRules } from "@services/kodyRules/fetch";
import { KodyRulesStatus } from "@services/kodyRules/types";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { resolveKodyRuleBadgeState } from "src/core/utils/kody-rules/resolve-badge-state";

function showLastPaths(path: string, max = 3): string {
    const items = path.split(",").map((g) => g.trim()).filter((g) => g.length > 0);
    if (items.length <= max) return path;
    return "..." + items.slice(-max).join(", ");
}

export const KodyRuleItem = ({
    rule,
    onAnyChange,
    showSuggestionsButton = false,
    selection,
    syncEnabledForRepo,
}: {
    rule: KodyRuleWithInheritanceDetails;
    onAnyChange: () => void;
    showSuggestionsButton?: boolean;
    /** Repo's `ideRulesSyncEnabled`; forwarded to OriginBadge so it can
     *  show the @kody-sync / Orphan maintenance badge only when off. */
    syncEnabledForRepo?: boolean;
    /** Optional bulk-selection wiring. When omitted the row renders
     *  without a checkbox (legacy / read-only views). When the rule
     *  isn't eligible (inherited / no uuid), pass `eligible: false`. */
    selection?: {
        isSelected: boolean;
        eligible: boolean;
        onToggle: () => void;
    };
}) => {
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const config = useFullCodeReviewConfig();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.KodyRules,
        repositoryId,
    );
    const canDelete = usePermission(
        Action.Delete,
        ResourceType.KodyRules,
        repositoryId,
    );

    const isInherited = !!rule.inherited;
    const isExcluded = isInherited && !!rule.excluded;
    const isMemory =
        (rule.type ?? KodyRulesType.STANDARD) === KodyRulesType.MEMORY;
    const centralizedPendingLabel =
        rule.centralizedConfig?.status === KodyRuleCentralizedStatus.PENDING_ADD
            ? "Pending add"
            : rule.centralizedConfig?.status ===
                KodyRuleCentralizedStatus.PENDING_DELETE
              ? "Pending delete"
              : rule.centralizedConfig?.status ===
                  KodyRuleCentralizedStatus.PENDING_EDIT
                ? "Pending edit"
                : null;
    const entityLabel = isMemory ? "memory" : "rule";
    const isPaused = rule.status === KodyRulesStatus.PAUSED;
    const badgeState = resolveKodyRuleBadgeState(rule);
    const isLockedByPlan = badgeState === "locked";

    // Opens the edit/view modal in place — same pattern Delete and "New
    // rule" already use — instead of navigating to the sibling
    // /kody-rules/[id] page. The route round-trip unmounted the whole
    // list into a full-page skeleton twice (open and close) and lost the
    // scroll position (#1274). The [id] route stays for deep links.
    const handleOpenRuleModal = async () => {
        const directory = config?.repositories
            .find((r) => r.id === repositoryId)
            ?.directories?.find((d) => d.id === directoryId);

        const response = await magicModal.show(() => (
            <KodyRuleAddOrUpdateItemModal
                rule={rule}
                repositoryId={repositoryId}
                directory={directory}
                canEdit={canEdit}
            />
        ));
        if (response) onAnyChange?.();
    };

    const [handleResume, { loading: isResuming }] = useAsyncAction(async () => {
        if (!rule.uuid) return;
        try {
            const result = await changeStatusKodyRules(
                [rule.uuid],
                KodyRulesStatus.ACTIVE,
            );
            // The backend never rejects a resume beyond the free-plan cap
            // anymore — it just keeps the rule PAUSED (lockedByPlan) instead
            // of reactivating it, same "created but locked" pattern as
            // plugins beyond their cap.
            const updated = Array.isArray(result)
                ? result.find((r) => r.uuid === rule.uuid)
                : undefined;

            if (updated?.lockedByPlan) {
                toast({
                    title: "Rule stayed locked",
                    description:
                        "You've hit the Free plan cap of 10 active Kody Rules. Upgrade to activate this one too.",
                    variant: "warning",
                });
            } else {
                toast({
                    description: "Rule resumed and is now enforced again.",
                    variant: "success",
                });
            }
            onAnyChange?.();
        } catch (error) {
            console.error("Failed to resume rule", error);
            toast({
                title: "Could not resume rule",
                description: "Please try again in a moment.",
                variant: "danger",
            });
        }
    });

    return (
        <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
                <div className="-mb-2 flex min-w-0 flex-1 flex-col gap-2">
                    <Heading variant="h3" className="text-base">
                        {rule.title}
                    </Heading>

                    <div className="flex flex-wrap items-center gap-1.5">
                        {selection?.eligible && (
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
                                className="border-card-lv3 bg-card-lv2 size-4 cursor-pointer rounded border accent-primary-light"
                            />
                        )}

                        {!isMemory && (
                            <IssueSeverityLevelBadge
                                severity={resolveKodyRuleDisplaySeverity(rule)}
                            />
                        )}

                        <OriginBadge
                            rule={rule}
                            syncEnabledForRepo={syncEnabledForRepo}
                        />

                        {isLockedByPlan ? (
                            <KodyRulesLimitPopover limit={10}>
                                <PopoverTrigger asChild>
                                    <Badge
                                        active
                                        size="xs"
                                        leftIcon={<LockIcon />}
                                        className="bg-primary-light/10 text-primary-light ring-primary-light/64 h-6 min-h-auto cursor-pointer rounded-lg px-2 text-[10px] leading-px uppercase ring-1">
                                        Locked
                                    </Badge>
                                </PopoverTrigger>
                            </KodyRulesLimitPopover>
                        ) : (
                            isPaused && (
                                <Tooltip delayDuration={500}>
                                    <TooltipTrigger>
                                        <Badge
                                            active
                                            size="xs"
                                            className="bg-warning/10 text-warning ring-warning/64 pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 [--button-foreground:var(--color-warning)]">
                                            Paused
                                        </Badge>
                                    </TooltipTrigger>

                                    <TooltipContent>
                                        <p>
                                            This {entityLabel} is paused. It
                                            stays in your list but is skipped
                                            on every new PR.
                                        </p>
                                        <p>Click the play icon to resume it.</p>
                                    </TooltipContent>
                                </Tooltip>
                            )
                        )}

                        {centralizedPendingLabel && (
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger>
                                    <Badge
                                        active
                                        size="xs"
                                        className="bg-warning/10 text-warning ring-warning/40 pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1">
                                        {centralizedPendingLabel}
                                    </Badge>
                                </TooltipTrigger>

                                <TooltipContent>
                                    <p>
                                        This {entityLabel} has a pending
                                        centralized configuration change.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        )}

                        {isInherited && (
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger>
                                    <Badge
                                        active
                                        size="xs"
                                        className="bg-muted/10 text-muted ring-muted/64 pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 [--button-foreground:var(--color-muted)]">
                                        Inherited: {rule.inherited}
                                    </Badge>
                                </TooltipTrigger>

                                <TooltipContent>
                                    <p>
                                        This {entityLabel} is inherited and
                                        cannot be edited or deleted here.
                                    </p>
                                    <p>
                                        Click the eye icon to view its details
                                        or to disable it for this scope.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        )}

                        {isExcluded && (
                            <Tooltip delayDuration={500}>
                                <TooltipTrigger>
                                    <Badge
                                        active
                                        size="xs"
                                        className="bg-muted/10 text-muted ring-muted/64 pointer-events-none h-6 min-h-auto rounded-lg px-2 text-[10px] leading-px uppercase ring-1 [--button-foreground:var(--color-muted)]">
                                        Disabled
                                    </Badge>
                                </TooltipTrigger>

                                <TooltipContent>
                                    <p>
                                        This {entityLabel} is inherited but
                                        disabled for this scope.
                                    </p>
                                    <p>
                                        Click the eye icon to view its details
                                        or to enable it for this scope.
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    {showSuggestionsButton && rule.uuid && (
                        <SuggestionsModal
                            ruleId={rule.uuid}
                            ruleTitle={rule.title}
                            variant="icon"
                        />
                    )}

                    {isPaused && !isInherited && (
                        <Button
                            size="icon-md"
                            variant="secondary"
                            aria-label={"Resume " + entityLabel}
                            className="size-9"
                            disabled={!canEdit || isResuming}
                            onClick={handleResume}>
                            <PlayIcon aria-hidden />
                        </Button>
                    )}

                    <Button
                        size="icon-md"
                        variant="secondary"
                        aria-label={
                            !canEdit || isInherited
                                ? "View " + entityLabel + " details"
                                : "Edit " + entityLabel
                        }
                        className="size-9"
                        onClick={handleOpenRuleModal}>
                        {!canEdit || isInherited ? (
                            <EyeIcon aria-hidden />
                        ) : (
                            <EditIcon aria-hidden />
                        )}
                    </Button>

                    <Button
                        size="icon-md"
                        variant="secondary"
                        aria-label={"Delete " + entityLabel}
                        className="size-9 [--button-foreground:var(--color-danger)]"
                        disabled={!canDelete || isInherited}
                        onClick={() => {
                            magicModal.show(() => (
                                <DeleteKodyRuleConfirmationModal
                                    rule={rule}
                                    onSuccess={() => onAnyChange?.()}
                                />
                            ));
                        }}>
                        <TrashIcon aria-hidden />
                    </Button>
                </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-3">
                <Card
                    color="lv1"
                    className="text-text-secondary -mx-6 -mb-6 flex-1 rounded-t-none text-sm">
                    <CardHeader>
                        <div className="flex flex-row">
                            <Section.Root className="flex-1">
                                <Section.Header>
                                    <Section.Title>
                                        {isMemory ? "Applies to:" : "Path:"}
                                    </Section.Title>
                                </Section.Header>

                                <Section.Content>
                                    {isMemory ? (
                                        "All prompts and conversations"
                                    ) : rule.path ? (
                                        // Plain monospaced text mirrors the
                                        // Source field below — the dark
                                        // InlineCode pill clashed with the
                                        // card surface and made Path look
                                        // heavier than any other field.
                                        <Tooltip delayDuration={500}>
                                            <TooltipTrigger asChild>
                                                <code className="font-mono text-xs">
                                                    {showLastPaths(rule.path)}
                                                </code>
                                            </TooltipTrigger>
                                            <TooltipPortal>
                                                <TooltipContent side="right" className="max-w-96">
                                                    <code className="font-mono text-xs break-all">
                                                        {rule.path}
                                                    </code>
                                                </TooltipContent>
                                            </TooltipPortal>
                                        </Tooltip>
                                    ) : (
                                        "all files (default)"
                                    )}
                                </Section.Content>
                            </Section.Root>

                            {rule.sourcePath && (
                                <>
                                    <Separator
                                        orientation="vertical"
                                        className="bg-card-lv2 mx-4"
                                    />

                                    <Section.Root className="flex-1">
                                        <Section.Header>
                                            <Section.Title>
                                                Source:
                                            </Section.Title>
                                        </Section.Header>

                                        <Section.Content>
                                            {rule.sourcePath}
                                        </Section.Content>
                                    </Section.Root>
                                </>
                            )}

                            {!isMemory && (
                                <>
                                    <Separator
                                        orientation="vertical"
                                        className="bg-card-lv2 mx-4"
                                    />

                                    <Section.Root className="flex-1 shrink">
                                        <Section.Header>
                                            <Section.Title>
                                                Scope:
                                            </Section.Title>
                                        </Section.Header>

                                        <Section.Content>
                                            {rule.scope === "pull-request"
                                                ? "Pull-request"
                                                : "File"}
                                        </Section.Content>
                                    </Section.Root>
                                </>
                            )}
                        </div>

                        <Separator className="bg-card-lv2 my-3" />

                        <Section.Root>
                            <Section.Header>
                                <Section.Title>Instructions:</Section.Title>
                            </Section.Header>

                            <Section.Content className="line-clamp-3">
                                {rule.rule}
                            </Section.Content>

                            <ExternalReferencesDisplay
                                externalReferences={{
                                    references: rule.externalReferences || [],
                                    syncErrors: rule.syncErrors || [],
                                    processingStatus:
                                        rule.referenceProcessingStatus ||
                                        "completed",
                                }}
                                compact
                            />
                        </Section.Root>
                    </CardHeader>
                </Card>
            </CardContent>
        </Card>
    );
};
