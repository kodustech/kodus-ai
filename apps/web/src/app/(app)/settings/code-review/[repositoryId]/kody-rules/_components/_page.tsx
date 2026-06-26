"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { KodyRulesLimitPopover } from "@components/system/kody-rules-limit-popover";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import { SvgKodyRulesDiscovery } from "@components/ui/icons/SvgKodyRulesDiscovery";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { PopoverTrigger } from "@components/ui/popover";
import { Skeleton } from "@components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { changeStatusKodyRules } from "@services/kodyRules/fetch";
import {
    useKodyRulesLimits,
    useSuspenseKodyRulesPageData,
} from "@services/kodyRules/hooks";
import {
    KodyRuleCentralizedStatus,
    KodyRuleRequestType,
    KodyRulesStatus,
    KodyRulesType,
    KodyRuleWithInheritanceDetails,
    type KodyRule,
} from "@services/kodyRules/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { PlusIcon } from "lucide-react";
import { PageBoundary } from "src/core/components/page-boundary";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import {
    compareRules,
    EMPTY_LIST_FILTERS,
    isOrphanAutoSyncRule,
    matchesKodySyncFilter,
    matchesOriginFilter,
    matchesPausedOnlyFilter,
    matchesSeverityFilter,
    matchesSyncErrorsFilter,
    matchesTextQuery,
    type ListFilters,
    type SortOption,
} from "src/core/utils/kody-rules/apply-filters";
import {
    applyFiltersToParams,
    parseFiltersFromParams,
} from "src/core/utils/kody-rules/serialize-filters";
import { safeArray } from "src/core/utils/safe-array";

import { CodeReviewPagesBreadcrumb } from "../../../_components/breadcrumb";
import { CentralizedConfigReadOnlyAlert } from "../../../_components/centralized-config-readonly-alert";
import { GenerateRulesOptions } from "../../../_components/generate-rules-options";
import { KodyRuleAddOrUpdateItemModal } from "../../../_components/modal";
import {
    useFullCodeReviewConfig,
    usePlatformConfig,
} from "../../../../_components/context";
import { useCodeReviewRouteParams } from "../../../../_hooks";
import { ActiveFiltersChips } from "./active-filters-chips";
import { BulkActionToolbar } from "./bulk-action-toolbar";
import { BulkDeleteConfirmationModal } from "./bulk-delete-confirmation-modal";
import { KodyRulesEmptyState } from "./empty";
import { KodyKnowledgeApprovalSetting } from "./knowledge-approval";
import { KodyRulesList } from "./list";
import { KodyRulesNoMatches } from "./no-matches";
import { OrphanRulesChip } from "./orphan-rules-chip";
import { KodyRulesPageSkeleton } from "./page-skeleton";
import { PendingSection } from "./pending-section";
import { SeverityHeatmap } from "./severity-heatmap";
import { KodyRulesToolbar, type VisibleScopes } from "./toolbar";

type KodyRulesTab = "review-rules" | "memories" | "configuration";
type RulesStatusFilter = "all" | "pending-centralized";
type PendingVisibility = "all" | "active" | "pending" | "updates";

const TAB_QUERY_PARAM = "tab";
const DEFAULT_TAB: KodyRulesTab = "review-rules";

const getRuleType = (rule: Pick<KodyRule, "type">) =>
    rule.type ?? KodyRulesType.STANDARD;

const isRulePendingCentralizedChange = (rule: KodyRule) => {
    return (
        rule.centralizedConfig?.status ===
            KodyRuleCentralizedStatus.PENDING_ADD ||
        rule.centralizedConfig?.status ===
            KodyRuleCentralizedStatus.PENDING_EDIT ||
        rule.centralizedConfig?.status ===
            KodyRuleCentralizedStatus.PENDING_DELETE
    );
};

// A 403 means the backend policy rejected the mutation (e.g. a repo admin
// acting on rules outside their assigned repos) — retrying will never
// succeed, so surface the real cause instead of the generic "try again".
const bulkActionErrorToast = (
    action: "pause" | "resume" | "delete",
    error: unknown,
) => ({
    title: `Could not ${action} rules`,
    description:
        isAxiosError(error) && error.response?.status === 403
            ? `You don't have permission to ${action} rules in this scope.`
            : isAxiosError(error) &&
                error.response?.data?.message ===
                    "Free plan's limit of Kody Rules reached."
              ? "You have reached the limit of 10 active Kody rules. Pause or delete another rule first."
              : "Please try again in a moment.",
    variant: "danger" as const,
});

const KodyRulesPageContent = () => {
    const platformConfig = usePlatformConfig();
    const config = useFullCodeReviewConfig();
    const pathname = usePathname();
    const router = useRouter();

    const searchParams = useSearchParams();
    const { repositoryId, directoryId } = useCodeReviewRouteParams();
    const queryClient = useQueryClient();
    const { teamId } = useSelectedTeamId();
    const kodyRulesLimits = useKodyRulesLimits();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.KodyRules,
        repositoryId,
    );

    // Scope rules and inherited rules are loaded in parallel (single
    // suspense boundary, both requests fired at once) to avoid the waterfall
    // that two back-to-back useSuspense* hooks produce.
    const { scopeRules: scopeKodyRules, inherited } =
        useSuspenseKodyRulesPageData({
            teamId,
            repositoryId,
            directoryId,
        });

    const {
        directoryRules: inheritedDirectoryRules = [],
        globalRules: inheritedGlobalRules = [],
        repoRules: inheritedRepoRules = [],
    } = inherited;

    const { activeRules: kodyRules, pendingRules } = safeArray(
        scopeKodyRules,
    ).reduce<{
        activeRules: KodyRule[];
        pendingRules: KodyRule[];
    }>(
        (result, rule) => {
            switch (rule.status) {
                case KodyRulesStatus.ACTIVE:
                    result.activeRules.push(rule);
                    break;
                // PAUSED rules stay visible in the user's list with a
                // distinct badge so they can be reviewed and resumed —
                // they just aren't enforced on PRs. Without this case
                // they were silently dropped and pause looked broken.
                case KodyRulesStatus.PAUSED:
                    result.activeRules.push(rule);
                    break;
                case KodyRulesStatus.PENDING:
                    result.pendingRules.push(rule);
                    break;
            }
            return result;
        },
        { activeRules: [], pendingRules: [] },
    );

    const isGlobalView = repositoryId === "global";
    const isRepoView = !isGlobalView && !directoryId;

    const activeTabSearchParam = searchParams.get(TAB_QUERY_PARAM);
    const activeTab: KodyRulesTab =
        activeTabSearchParam === "memories" ||
        activeTabSearchParam === "configuration"
            ? activeTabSearchParam
            : DEFAULT_TAB;

    // SSR-safe init: useState always returns the same empty value during
    // server rendering AND first client paint, so React hydration sees a
    // consistent tree. The actual URL parsing happens in a useEffect below
    // (post-mount) where window/URLSearchParams are guaranteed to exist.
    const [filterQuery, setFilterQuery] = useState("");
    const [visibleScopes, setVisibleScopes] = useState<VisibleScopes>({
        self: true,
        dir: true,
        repo: true,
        global: true,
        disabled: true,
    });
    const [statusFilter, setStatusFilter] = useState<RulesStatusFilter>("all");
    const [pendingVisibility, setPendingVisibility] =
        useState<PendingVisibility>("all");
    const [onlyIdeSynced, setOnlyIdeSynced] = useState(false);
    const [listFilters, setListFilters] =
        useState<ListFilters>(EMPTY_LIST_FILTERS);
    const [sortOption, setSortOption] = useState<SortOption>("recent");
    const [hasReadUrl, setHasReadUrl] = useState(false);
    const [selection, setSelection] = useState<Set<string>>(
        () => new Set<string>(),
    );

    // Hydrate filter state from the URL after mount. Done in an effect so
    // the SSR HTML and the first client render match — otherwise React
    // reports a hydration mismatch when deep-link params seed CSR state
    // but were missing on the server pass.
    useEffect(() => {
        const params = new URLSearchParams(searchParams?.toString() ?? "");
        const parsed = parseFiltersFromParams(params);
        setFilterQuery(parsed.query);
        setListFilters(parsed.listFilters);
        setOnlyIdeSynced(parsed.onlyOrphans);
        setHasReadUrl(true);
        // Run only on mount; subsequent URL syncs flow the OTHER way
        // (state → URL) via the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Push filter state into the URL whenever it changes so refresh / share
    // restores it. Skips the very first run (before initial URL was parsed)
    // to avoid clobbering deep-link params during mount.
    useEffect(() => {
        if (!hasReadUrl) return;
        const next = new URLSearchParams(searchParams?.toString() ?? "");
        applyFiltersToParams(next, {
            query: filterQuery,
            listFilters,
            onlyOrphans: onlyIdeSynced,
        });
        const nextStr = next.toString();
        const currentStr = searchParams?.toString() ?? "";
        if (nextStr === currentStr) return;
        router.replace(nextStr ? pathname + "?" + nextStr : pathname);
    }, [
        hasReadUrl,
        filterQuery,
        listFilters,
        onlyIdeSynced,
        pathname,
        router,
        searchParams,
    ]);

    const ideRulesSyncEnabledForRepo =
        !isGlobalView &&
        // `configs.ideRulesSyncEnabled` is a FormattedConfigProperty
        // ({ value, level, ... }), not a raw boolean. `Boolean(<object>)`
        // is always true, which made `ideRulesSyncEnabledForRepo` look
        // permanently `true` and suppressed the OrphanRulesBanner from
        // ever rendering. Read `.value` explicitly.
        config.repositories?.find((r) => r.id === repositoryId)?.configs
            ?.ideRulesSyncEnabled?.value === true;

    // Orphan auto-sync rules: anything imported from IDE rule files
    // (.cursorrules, .cursor/rules/**, CLAUDE.md, …) that survived the
    // sync-off event, regardless of whether the user kept them ACTIVE or
    // parked them as PAUSED. PAUSED rules are still "in the user's lap" —
    // a one-click Resume puts them back in PR review, so they belong in
    // the count. Onboarding / Kody-generated rules share the
    // "sourcePath is set" shape but come from unrelated flows and don't
    // count here.
    //
    // Rules with `pinnedSync=true` are EXCLUDED: their source file
    // carries `@kody-sync`, so the backend keeps syncing them even
    // when the repo toggle is off. They're actively maintained, not
    // orphans. See `kodyRulesSync.service.ts:shouldForceSync`.
    // Orphan auto-sync count is derived from the rules ACTUALLY ON SCREEN
    // (self + inherited, per visibleScopes) inside getRulesViewState as
    // `orphanCount`, then gated for the chip after reviewRulesState below.
    // This keeps the banner number equal to the cards showing the "Orphan"
    // badge — including inherited ones — instead of a separate scope-fetch.

    const getRulesViewState = (ruleType: KodyRulesType) => {
        const activeRulesByType = kodyRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );
        const inheritedGlobalRulesByType = inheritedGlobalRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );
        const inheritedRepoRulesByType = inheritedRepoRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );
        const inheritedDirectoryRulesByType = inheritedDirectoryRules.filter(
            (rule) => getRuleType(rule) === ruleType,
        );

        const repositoryOnlyRules =
            directoryId || repositoryId === "global"
                ? []
                : activeRulesByType.filter((rule) => !rule.directoryId);

        const directoryOnlyRules =
            !directoryId || repositoryId === "global"
                ? []
                : activeRulesByType.filter(
                      (rule) => rule.directoryId === directoryId,
                  );

        const sourceRuleSets = [] as (
            | KodyRule
            | KodyRuleWithInheritanceDetails
        )[][];

        if (isGlobalView) {
            sourceRuleSets.push(activeRulesByType);
        } else if (isRepoView) {
            if (visibleScopes.self) sourceRuleSets.push(repositoryOnlyRules);
            if (visibleScopes.global)
                sourceRuleSets.push(inheritedGlobalRulesByType);
        } else {
            if (visibleScopes.self) sourceRuleSets.push(directoryOnlyRules);
            if (visibleScopes.dir)
                sourceRuleSets.push(inheritedDirectoryRulesByType);
            if (visibleScopes.repo)
                sourceRuleSets.push(inheritedRepoRulesByType);
            if (visibleScopes.global)
                sourceRuleSets.push(inheritedGlobalRulesByType);
        }

        const combinedRules = sourceRuleSets.flat();

        const activeRules = visibleScopes.disabled
            ? combinedRules
            : combinedRules.filter(
                  (rule) => !("excluded" in rule) || !rule.excluded,
              );

        const uniqueRulesMap = new Map<
            string,
            KodyRule | KodyRuleWithInheritanceDetails
        >();
        for (const rule of activeRules) {
            if (rule.uuid) {
                uniqueRulesMap.set(rule.uuid, rule);
            }
        }
        const uniqueRules = Array.from(uniqueRulesMap.values());

        const orphanCount =
            ruleType === KodyRulesType.STANDARD
                ? uniqueRules.filter(isOrphanAutoSyncRule).length
                : 0;

        const pendingCentralizedCount = activeRulesByType.filter((rule) =>
            isRulePendingCentralizedChange(rule),
        ).length;

        const statusFilteredRules =
            statusFilter === "pending-centralized"
                ? uniqueRules.filter((rule) =>
                      isRulePendingCentralizedChange(rule as KodyRule),
                  )
                : uniqueRules;

        const bannerFilteredRules =
            onlyIdeSynced && ruleType === KodyRulesType.STANDARD
                ? statusFilteredRules.filter(isOrphanAutoSyncRule)
                : statusFilteredRules;

        // Popover filters: origin (Auto-sync / Onboarding / Kody-generated /
        // manual), sync state, paused-only — everything EXCEPT severity,
        // which is applied last (below) so the heatmap can count this
        // pool. Origin only applies to standard rules (memories don't
        // have these origins).
        const nonSeverityFilteredRules = bannerFilteredRules.filter((rule) => {
            const passesOrigin =
                ruleType !== KodyRulesType.STANDARD ||
                matchesOriginFilter(rule as KodyRule, listFilters);
            const passesSyncErrors =
                ruleType !== KodyRulesType.STANDARD ||
                matchesSyncErrorsFilter(rule as KodyRule, listFilters);
            const passesPausedOnly =
                ruleType !== KodyRulesType.STANDARD ||
                matchesPausedOnlyFilter(rule as KodyRule, listFilters);
            const passesKodySync =
                ruleType !== KodyRulesType.STANDARD ||
                matchesKodySyncFilter(rule as KodyRule, listFilters);
            return (
                passesOrigin &&
                passesSyncErrors &&
                passesPausedOnly &&
                passesKodySync
            );
        });

        const filterQueryLowercase = filterQuery.toLowerCase();
        const queryFilteredRules = !filterQuery
            ? nonSeverityFilteredRules
            : nonSeverityFilteredRules.filter((rule) =>
                  matchesTextQuery(rule as KodyRule, filterQueryLowercase),
              );

        const listFilteredRules = queryFilteredRules.filter(
            (rule) =>
                ruleType !== KodyRulesType.STANDARD ||
                matchesSeverityFilter(rule as KodyRule, listFilters),
        );

        const rulesToDisplay = [...listFilteredRules].sort((x, y) =>
            compareRules(x as KodyRule, y as KodyRule, sortOption),
        );

        const hasAnyRulesInSystem =
            activeRulesByType.length > 0 ||
            inheritedGlobalRulesByType.length > 0 ||
            inheritedRepoRulesByType.length > 0 ||
            inheritedDirectoryRulesByType.length > 0;

        // Severity distribution over the pool with every OTHER filter
        // (origin, sync, paused, text query) already applied, but NOT the
        // severity selection itself: each chip must match the cards on
        // screen when other filters are active (e.g. Origin: Library → "2
        // High", not the unfiltered "4 High"), while clicking "Critical"
        // still must not zero out the High/Medium/Low counters.
        const severityCounts: Record<string, number> = {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
        };
        for (const rule of queryFilteredRules) {
            const sev = (rule as KodyRule).severity?.toLowerCase();
            if (sev && severityCounts[sev] !== undefined) {
                severityCounts[sev] += 1;
            }
        }

        return {
            rulesToDisplay,
            hasAnyRulesInSystem,
            pendingCentralizedCount,
            severityCounts,
            orphanCount,
        };
    };

    const reviewRulesState = useMemo(
        () => getRulesViewState(KodyRulesType.STANDARD),
        [
            visibleScopes,
            filterQuery,
            isGlobalView,
            isRepoView,
            kodyRules,
            inheritedGlobalRules,
            inheritedRepoRules,
            inheritedDirectoryRules,
            directoryId,
            repositoryId,
            statusFilter,
            onlyIdeSynced,
            listFilters,
            sortOption,
        ],
    );

    // The chip is meaningful only inside a repo/dir scope with sync off; the
    // value itself counts every orphan-badged rule currently on screen
    // (self + inherited), so the banner number matches the cards exactly.
    const orphanRulesCount =
        !isGlobalView && !ideRulesSyncEnabledForRepo
            ? reviewRulesState.orphanCount
            : 0;

    const memoriesState = useMemo(
        () => getRulesViewState(KodyRulesType.MEMORY),
        [
            visibleScopes,
            filterQuery,
            isGlobalView,
            isRepoView,
            kodyRules,
            inheritedGlobalRules,
            inheritedRepoRules,
            inheritedDirectoryRules,
            directoryId,
            repositoryId,
            statusFilter,
            // onlyIdeSynced is read inside getRulesViewState; even though
            // it only affects STANDARD rules today, omitting it here would
            // produce a stale memory list the moment that guard changes.
            onlyIdeSynced,
            listFilters,
            sortOption,
        ],
    );

    // Bulk selection — only enabled in the Review Rules tab. Eligibility:
    // the rule belongs to the current scope (not inherited) and has a uuid
    // we can pass to `changeStatusKodyRules`. Inherited rows render
    // without a checkbox so the user cannot accidentally try to delete a
    // rule that lives in another scope.
    const isBulkEligible = (rule: KodyRuleWithInheritanceDetails) =>
        !rule.inherited && !!rule.uuid;

    const eligibleSelectableIds = useMemo(() => {
        const ids: string[] = [];
        for (const rule of reviewRulesState.rulesToDisplay as KodyRuleWithInheritanceDetails[]) {
            if (isBulkEligible(rule)) ids.push(rule.uuid as string);
        }
        return ids;
    }, [reviewRulesState.rulesToDisplay]);

    // Drop selected ids that are no longer visible/eligible (filters
    // changed, list refreshed, …). Without this the count in the toolbar
    // would drift away from what the user actually sees.
    useEffect(() => {
        setSelection((prev) => {
            if (prev.size === 0) return prev;
            const visible = new Set(eligibleSelectableIds);
            let changed = false;
            const next = new Set<string>();
            for (const id of prev) {
                if (visible.has(id)) {
                    next.add(id);
                } else {
                    changed = true;
                }
            }
            return changed ? next : prev;
        });
    }, [eligibleSelectableIds]);

    const toggleSelection = (ruleId: string) => {
        setSelection((prev) => {
            const next = new Set(prev);
            if (next.has(ruleId)) {
                next.delete(ruleId);
            } else {
                next.add(ruleId);
            }
            return next;
        });
    };

    const selectAllVisible = () => {
        setSelection(new Set(eligibleSelectableIds));
    };

    const clearSelection = () => {
        setSelection(new Set());
    };

    const [handleBulkDelete, { loading: isBulkDeleting }] = useAsyncAction(
        async () => {
            const ids = Array.from(selection);
            if (ids.length === 0) return;

            // Selection only contains scope-local rules (the toolbar
            // disables inherited cards), so `kodyRules` is the right
            // pool to resolve titles from.
            const titles = kodyRules
                .filter((rule) => rule.uuid && selection.has(rule.uuid))
                .map((rule) => rule.title ?? "Untitled rule");

            const confirmed = await magicModal.show<boolean>(() => (
                <BulkDeleteConfirmationModal titles={titles} />
            ));
            if (!confirmed) return;

            try {
                await changeStatusKodyRules(ids, KodyRulesStatus.DELETED);
                toast({
                    description:
                        ids.length === 1
                            ? "1 rule deleted."
                            : `${ids.length} rules deleted.`,
                    variant: "success",
                });
                clearSelection();
                await refreshRulesList();
            } catch (error) {
                console.error("Failed to bulk delete rules", error);
                toast(bulkActionErrorToast("delete", error));
            }
        },
    );

    // Split the current selection by status. The bulk Pause button only
    // operates on ACTIVE rules and Resume only on PAUSED ones — sending the
    // whole selection would no-op on already-paused / already-active rules
    // and inflate the toast count. Recomputed every render off the live
    // `rulesToDisplay` snapshot so a status flip elsewhere reflects here.
    const { pauseableIds, resumableIds } = useMemo(() => {
        const pauseable: string[] = [];
        const resumable: string[] = [];
        for (const rule of reviewRulesState.rulesToDisplay as KodyRuleWithInheritanceDetails[]) {
            if (!rule.uuid || !selection.has(rule.uuid)) continue;
            if (rule.inherited) continue;
            if (rule.status === KodyRulesStatus.ACTIVE) {
                pauseable.push(rule.uuid);
            } else if (rule.status === KodyRulesStatus.PAUSED) {
                resumable.push(rule.uuid);
            }
        }
        return { pauseableIds: pauseable, resumableIds: resumable };
    }, [reviewRulesState.rulesToDisplay, selection]);

    const [handleBulkPause, { loading: isBulkPausing }] = useAsyncAction(
        async () => {
            if (pauseableIds.length === 0) return;
            try {
                await changeStatusKodyRules(
                    pauseableIds,
                    KodyRulesStatus.PAUSED,
                );
                toast({
                    description:
                        pauseableIds.length === 1
                            ? "1 rule paused."
                            : `${pauseableIds.length} rules paused.`,
                    variant: "success",
                });
                clearSelection();
                await refreshRulesList();
            } catch (error) {
                console.error("Failed to bulk pause rules", error);
                toast(bulkActionErrorToast("pause", error));
            }
        },
    );

    const [handleBulkResume, { loading: isBulkResuming }] = useAsyncAction(
        async () => {
            if (resumableIds.length === 0) return;
            try {
                await changeStatusKodyRules(
                    resumableIds,
                    KodyRulesStatus.ACTIVE,
                );
                toast({
                    description:
                        resumableIds.length === 1
                            ? "1 rule resumed."
                            : `${resumableIds.length} rules resumed.`,
                    variant: "success",
                });
                clearSelection();
                await refreshRulesList();
            } catch (error) {
                console.error("Failed to bulk resume rules", error);
                toast(bulkActionErrorToast("resume", error));
            }
        },
    );

    const renderPendingMergeFilter = (pendingCentralizedCount: number) => {
        if (pendingCentralizedCount === 0 && statusFilter === "all") {
            return null;
        }

        return (
            <div className="flex items-center gap-2">
                <Button
                    size="xs"
                    variant={statusFilter === "all" ? "primary" : "secondary"}
                    onClick={() => setStatusFilter("all")}>
                    All
                </Button>
                <Button
                    size="xs"
                    variant={
                        statusFilter === "pending-centralized"
                            ? "primary"
                            : "secondary"
                    }
                    onClick={() => setStatusFilter("pending-centralized")}>
                    Pending centralized ({pendingCentralizedCount})
                </Button>
            </div>
        );
    };

    const isUpdateRequest = (rule: KodyRule) =>
        rule.requestType === KodyRuleRequestType.UPDATE;

    const pendingByType = (ruleType: KodyRulesType) =>
        pendingRules.filter((rule) => getRuleType(rule) === ruleType);

    // Inline pending area for a tab: a visibility filter (All / Active /
    // Pending / Updates) plus the distinct pending section. The same filter
    // also drives whether the active list below renders (see `showActiveList`).
    const renderPendingControls = (
        items: KodyRule[],
        entityLabel: "rules" | "memories",
    ) => {
        if (items.length === 0) return null;

        const updatesCount = items.filter(isUpdateRequest).length;
        const sectionItems =
            pendingVisibility === "updates"
                ? items.filter(isUpdateRequest)
                : items;

        const option = (value: PendingVisibility, label: string) => (
            <Button
                size="xs"
                variant={pendingVisibility === value ? "primary" : "secondary"}
                onClick={() => setPendingVisibility(value)}>
                {label}
            </Button>
        );

        return (
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    {option("all", "All")}
                    {option("active", "Active only")}
                    {option("pending", `Pending (${items.length})`)}
                    {updatesCount > 0 &&
                        option("updates", `Updates (${updatesCount})`)}
                </div>
                {pendingVisibility !== "active" && (
                    <PendingSection
                        pendingRules={sectionItems}
                        activeRules={kodyRules}
                        entityLabel={entityLabel}
                        teamId={teamId}
                        canEdit={canEdit}
                        refreshRulesList={refreshRulesList}
                    />
                )}
            </div>
        );
    };

    // When pending items exist, "Pending"/"Updates" hides the active list so
    // the user focuses on review; "All"/"Active only" keep it visible.
    const showActiveList = (items: KodyRule[]) =>
        items.length === 0 ||
        pendingVisibility === "all" ||
        pendingVisibility === "active";

    const handleTabChange = (tab: string) => {
        if (
            tab !== "review-rules" &&
            tab !== "memories" &&
            tab !== "configuration"
        ) {
            return;
        }

        const params = new URLSearchParams(searchParams.toString());
        if (tab === DEFAULT_TAB) {
            params.delete(TAB_QUERY_PARAM);
        } else {
            params.set(TAB_QUERY_PARAM, tab);
        }

        const nextUrl = params.toString()
            ? `${pathname}?${params.toString()}`
            : pathname;

        router.replace(nextUrl);
    };

    const refreshRulesList = async () => {
        // `invalidateQueries`, NOT `resetQueries`. The list is fed by
        // `useSuspenseFetch`, so resetting puts the query into "pending"
        // and bubbles up to the nearest Suspense boundary — which is what
        // was causing the page to flash to a skeleton on every delete /
        // pause / resume. Invalidate marks the cache as stale and triggers
        // a background refetch while the existing UI stays mounted, so the
        // list updates in place without flicker.
        await Promise.all([
            queryClient.invalidateQueries({
                predicate: (query) =>
                    query.queryKey[0] ===
                    KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
            }),
            queryClient.invalidateQueries({
                predicate: (query) =>
                    query.queryKey[0] ===
                    KODY_RULES_PATHS.GET_INHERITED_RULES,
            }),
            queryClient.invalidateQueries({
                predicate: (query) =>
                    query.queryKey[0] ===
                    KODY_RULES_PATHS.GET_KODY_RULES_TOTAL_QUANTITY,
            }),
        ]);
    };

    const addNewEmptyRule = async (ruleType: KodyRulesType) => {
        if (activeTab === "configuration") return;

        const directory = config.repositories
            .find((r) => r.id === repositoryId)
            ?.directories?.find((d) => d.id === directoryId);

        const response = await magicModal.show(() => (
            <KodyRuleAddOrUpdateItemModal
                repositoryId={repositoryId}
                directory={directory}
                canEdit={canEdit}
                ruleType={ruleType}
            />
        ));

        if (response) await refreshRulesList();
    };

    // Rule eligibility for bulk select: must be a real (non-inherited)
    // rule that the user can actually delete in this scope. Computed
    // every render directly — `reviewRulesState.rulesToDisplay` already
    // gets a fresh array each render (from the .sort step), so memoizing
    // would not help and would fight the actual derivation.
    const activeRuleType =
        activeTab === "memories"
            ? KodyRulesType.MEMORY
            : KodyRulesType.STANDARD;

    const currentEntityLabel = activeTab === "memories" ? "memory" : "rule";

    const headerDescription =
        "Review Rules run in the dedicated code review stage. Memories are injected across prompts and conversations to provide persistent context.";

    const showHeaderActions = activeTab !== "configuration";

    const canShowDiscovery = activeTab === "review-rules";

    return (
        <Page.Root>
            <Page.Header>
                <CodeReviewPagesBreadcrumb pageName="Kody Rules" />
            </Page.Header>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Kody Rules</Page.Title>
                    <Page.Description>{headerDescription}</Page.Description>
                </Page.TitleContainer>

                {showHeaderActions && (
                    <div className="flex flex-col gap-2">
                        <Page.HeaderActions className="justify-end">
                            {canShowDiscovery && (
                                <Link href="/library/kody-rules/featured">
                                    <Button
                                        size="md"
                                        decorative
                                        variant="secondary"
                                        leftIcon={<SvgKodyRulesDiscovery />}>
                                        Discovery
                                    </Button>
                                </Link>
                            )}

                            {kodyRulesLimits.canAddMoreRules ? (
                                <Button
                                    size="md"
                                    type="button"
                                    variant="primary"
                                    leftIcon={<PlusIcon />}
                                    disabled={!canEdit}
                                    onClick={() =>
                                        addNewEmptyRule(activeRuleType)
                                    }>
                                    New {currentEntityLabel}
                                </Button>
                            ) : (
                                <KodyRulesLimitPopover
                                    limit={kodyRulesLimits.limit}>
                                    <PopoverTrigger asChild>
                                        <Button
                                            size="md"
                                            type="button"
                                            variant="primary"
                                            leftIcon={<PlusIcon />}
                                            disabled={!canEdit}>
                                            New {currentEntityLabel}
                                        </Button>
                                    </PopoverTrigger>
                                </KodyRulesLimitPopover>
                            )}
                        </Page.HeaderActions>
                    </div>
                )}
            </Page.Header>

            <Page.Content>
                <CentralizedConfigReadOnlyAlert />
                <Tabs value={activeTab} onValueChange={handleTabChange}>
                    <TabsList>
                        <TabsTrigger value="review-rules">
                            Review Rules
                            {pendingByType(KodyRulesType.STANDARD).length >
                                0 && (
                                <Badge
                                    active
                                    size="xs"
                                    className="ml-2 min-h-auto">
                                    {
                                        pendingByType(KodyRulesType.STANDARD)
                                            .length
                                    }
                                </Badge>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="memories">
                            Memories
                            {pendingByType(KodyRulesType.MEMORY).length > 0 && (
                                <Badge
                                    active
                                    size="xs"
                                    className="ml-2 min-h-auto">
                                    {pendingByType(KodyRulesType.MEMORY).length}
                                </Badge>
                            )}
                        </TabsTrigger>
                        <TabsTrigger value="configuration">
                            Configuration
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="review-rules" className="mt-4">
                        <div className="flex flex-col gap-4">
                            <p className="text-text-secondary text-sm">
                                Review Rules run in the code review pipeline and
                                generate review feedback based on changed files
                                or PR-level context.
                            </p>
                            {renderPendingControls(
                                pendingByType(KodyRulesType.STANDARD),
                                "rules",
                            )}
                            {showActiveList(
                                pendingByType(KodyRulesType.STANDARD),
                            ) && (
                                <>
                                    <KodyRulesToolbar
                                        filterQuery={filterQuery}
                                        onFilterQueryChange={setFilterQuery}
                                        entityLabel="rules"
                                        visibleScopes={visibleScopes}
                                        onVisibleScopesChange={setVisibleScopes}
                                        listFilters={listFilters}
                                        onListFiltersChange={setListFilters}
                                        sortOption={sortOption}
                                        onSortOptionChange={setSortOption}
                                        isDisabled={
                                            !reviewRulesState.hasAnyRulesInSystem
                                        }
                                        isRepoView={isRepoView}
                                        isGlobalView={isGlobalView}
                                    />
                                    <OrphanRulesChip
                                        count={orphanRulesCount}
                                        isFiltering={onlyIdeSynced}
                                        onApply={() => setOnlyIdeSynced(true)}
                                        onClear={() => setOnlyIdeSynced(false)}
                                    />
                                    <ActiveFiltersChips
                                        filters={listFilters}
                                        onChange={setListFilters}
                                        entityLabel="rules"
                                    />
                                    <SeverityHeatmap
                                        counts={reviewRulesState.severityCounts}
                                        filters={listFilters}
                                        onFiltersChange={setListFilters}
                                    />
                                    {renderPendingMergeFilter(
                                        reviewRulesState.pendingCentralizedCount,
                                    )}
                                    {/* Bulk actions are mutations — without
                                        Update permission on this scope (e.g.
                                        repo admin on the Global page) the
                                        backend rejects them all, so don't offer
                                        selection at all. */}
                                    {canEdit && (
                                        <BulkActionToolbar
                                            selectedCount={selection.size}
                                            eligibleCount={
                                                eligibleSelectableIds.length
                                            }
                                            pauseableCount={pauseableIds.length}
                                            resumableCount={resumableIds.length}
                                            isDeleting={isBulkDeleting}
                                            isPausing={isBulkPausing}
                                            isResuming={isBulkResuming}
                                            onSelectAll={selectAllVisible}
                                            onClear={clearSelection}
                                            onDelete={handleBulkDelete}
                                            onPause={handleBulkPause}
                                            onResume={handleBulkResume}
                                        />
                                    )}
                                </>
                            )}
                            {(() => {
                                if (
                                    !showActiveList(
                                        pendingByType(KodyRulesType.STANDARD),
                                    )
                                )
                                    return null;
                                const empty =
                                    !reviewRulesState.rulesToDisplay.length;
                                if (!empty) {
                                    return (
                                        <KodyRulesList
                                            rules={
                                                reviewRulesState.rulesToDisplay
                                            }
                                            tab="review-rules"
                                            onAnyChange={refreshRulesList}
                                            bulkSelection={
                                                canEdit
                                                    ? {
                                                          selection,
                                                          onToggle:
                                                              toggleSelection,
                                                          isEligible:
                                                              isBulkEligible,
                                                      }
                                                    : undefined
                                            }
                                            syncEnabledForRepo={
                                                isGlobalView
                                                    ? undefined
                                                    : ideRulesSyncEnabledForRepo
                                            }
                                        />
                                    );
                                }
                                if (reviewRulesState.hasAnyRulesInSystem) {
                                    return (
                                        <KodyRulesNoMatches
                                            entityLabel="rule"
                                            onClearFilters={() => {
                                                setFilterQuery("");
                                                setListFilters(
                                                    EMPTY_LIST_FILTERS,
                                                );
                                                setOnlyIdeSynced(false);
                                            }}
                                        />
                                    );
                                }
                                return (
                                    <KodyRulesEmptyState
                                        canEdit={canEdit}
                                        entityLabel="rule"
                                        onAddNewRule={() =>
                                            addNewEmptyRule(
                                                KodyRulesType.STANDARD,
                                            )
                                        }
                                    />
                                );
                            })()}
                        </div>
                    </TabsContent>

                    <TabsContent value="memories" className="mt-4">
                        <div className="flex flex-col gap-4">
                            <p className="text-text-secondary text-sm">
                                Memories are persistent contextual instructions
                                injected across generation, safeguard, and
                                conversation prompts.
                            </p>
                            {renderPendingControls(
                                pendingByType(KodyRulesType.MEMORY),
                                "memories",
                            )}
                            {showActiveList(
                                pendingByType(KodyRulesType.MEMORY),
                            ) && (
                                <>
                                    <KodyRulesToolbar
                                        filterQuery={filterQuery}
                                        onFilterQueryChange={setFilterQuery}
                                        entityLabel="memories"
                                        visibleScopes={visibleScopes}
                                        onVisibleScopesChange={setVisibleScopes}
                                        listFilters={listFilters}
                                        onListFiltersChange={setListFilters}
                                        sortOption={sortOption}
                                        onSortOptionChange={setSortOption}
                                        isDisabled={
                                            !memoriesState.hasAnyRulesInSystem
                                        }
                                        isRepoView={isRepoView}
                                        isGlobalView={isGlobalView}
                                    />
                                    <ActiveFiltersChips
                                        filters={listFilters}
                                        onChange={setListFilters}
                                        entityLabel="memories"
                                    />
                                    {renderPendingMergeFilter(
                                        memoriesState.pendingCentralizedCount,
                                    )}
                                </>
                            )}
                            {showActiveList(
                                pendingByType(KodyRulesType.MEMORY),
                            ) &&
                                (!memoriesState.rulesToDisplay.length ? (
                                    <KodyRulesEmptyState
                                        canEdit={canEdit}
                                        entityLabel="memory"
                                        showDiscovery={false}
                                        onAddNewRule={() =>
                                            addNewEmptyRule(
                                                KodyRulesType.MEMORY,
                                            )
                                        }
                                    />
                                ) : (
                                    <KodyRulesList
                                        rules={memoriesState.rulesToDisplay}
                                        tab="memories"
                                        onAnyChange={refreshRulesList}
                                    />
                                ))}
                        </div>
                    </TabsContent>

                    <TabsContent value="configuration" className="mt-4">
                        <div className="flex flex-col gap-4">
                            <KodyKnowledgeApprovalSetting />

                            {isRepoView && (
                                <Suspense
                                    fallback={<Skeleton className="h-15" />}>
                                    <GenerateRulesOptions />
                                </Suspense>
                            )}
                        </div>
                    </TabsContent>
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
};

export const KodyRulesPage = () => {
    return (
        <PageBoundary
            errorVariant="card"
            errorMessage="Failed to load Kody Rules. Please try again."
            loading={<KodyRulesPageSkeleton />}>
            <KodyRulesPageContent />
        </PageBoundary>
    );
};
