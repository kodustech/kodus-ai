"use client";

import { useEffect, useMemo } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { useEffectOnce } from "@hooks/use-effect-once";
import { useIssues } from "@services/issues/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { TriangleAlertIcon } from "lucide-react";
import { parseAsJson, useQueryState } from "nuqs";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { filterArray, type FilterValueGroup } from "src/core/utils/filtering";
import { greeting } from "src/core/utils/helpers";
import { hasPermission } from "src/core/utils/permission-map";
import { safeArray } from "src/core/utils/safe-array";
import { CockpitNavTabs } from "src/features/ee/cockpit/_components/cockpit-nav-tabs";

import { IssuesDataTable } from "./_components/data-table";
import { IssuesFilters } from "./_components/filters";
import { IssueCreationToggle } from "./_components/issue-creation-toggle";
import { IssueDetailsRightSheet } from "./_components/issue-details-right-sheet";
import { DEFAULT_FILTERS, getFiltersInLocalStorage } from "./_constants";
import { FiltersContext } from "./_contexts/filters";

export default function IssuesPage() {
    const permissions = usePermissions();
    const { organizationId } = useAuth();

    const { data: issues, isLoading, error } = useIssues();

    const canAccessIssues = useMemo(() => {
        return safeArray(issues).filter((issue) =>
            hasPermission({
                permissions,
                organizationId: organizationId!,
                action: Action.Read,
                resource: ResourceType.Issues,
                repoId: issue.repository.id,
            }),
        );
    }, [issues, permissions, organizationId]);

    const [peek] = useQueryState("peek");

    const [_filtersQuery, setFilters] = useQueryState("filters", {
        ...parseAsJson((j) => {
            try {
                if (!j) {
                    return DEFAULT_FILTERS;
                }

                if (typeof j === "string") {
                    const parsed = JSON.parse(j) as FilterValueGroup;
                    return parsed;
                }

                return j as FilterValueGroup;
            } catch {
                return DEFAULT_FILTERS;
            }
        }),
        history: "push",
        clearOnDefault: false,
        parse: (value) => {
            try {
                const parsed = JSON.parse(decodeURIComponent(value));
                return parsed;
            } catch {
                return DEFAULT_FILTERS;
            }
        },
        serialize: (value) => {
            try {
                const serialized = encodeURIComponent(JSON.stringify(value));
                return serialized;
            } catch {
                return encodeURIComponent(JSON.stringify(DEFAULT_FILTERS));
            }
        },
    });

    const savedFiltersOrDefault = getFiltersInLocalStorage() ?? DEFAULT_FILTERS;
    const filters = _filtersQuery ?? savedFiltersOrDefault;

    const filteredData = useMemo(
        () => filterArray(filters, canAccessIssues),
        [filters, canAccessIssues],
    );

    const unresolvedIssues = useMemo(
        () => canAccessIssues.filter((issue) => issue.status !== "resolved"),
        [canAccessIssues],
    );

    useEffectOnce(() => {
        if (_filtersQuery) return;
        setFilters(savedFiltersOrDefault, { history: "replace" });
    });

    useEffect(() => {
        const listItem = globalThis.document.querySelector(`[data-peek]`);

        listItem?.scrollIntoView({
            block: "center",
            inline: "center",
            behavior: "smooth",
        });
    }, [peek]);

    return (
        <Page.Root className="overflow-hidden pb-0">
            {/* Same top band as the Cockpit so Issues reads as its third tab.
                The Cockpit's repository/date pickers stay out: they scope the
                metrics, while this list has its own filters. */}
            <Page.Header>
                <Page.Title>{greeting()}</Page.Title>
            </Page.Header>
            <Page.Header>
                <CockpitNavTabs />
            </Page.Header>
            <Page.Header>
                <div className="flex items-center gap-5">
                    <Page.Title>Issues</Page.Title>

                    <div className="flex items-center gap-3">
                        <FiltersContext value={{ filters, setFilters }}>
                            <IssuesFilters />
                        </FiltersContext>

                        {canAccessIssues.length > 0 && (
                            <span className="flex gap-0.5 text-sm">
                                <span>Showing </span>
                                {unresolvedIssues.length !== issues.length ? (
                                    <>
                                        <span className="text-text-secondary">
                                            of {unresolvedIssues.length} issues
                                        </span>
                                    </>
                                ) : (
                                    <span className="text-text-secondary">
                                        all {canAccessIssues.length} issues
                                    </span>
                                )}
                            </span>
                        )}
                    </div>
                </div>

                <IssueCreationToggle />
            </Page.Header>

            {/* min-h-0 lets the virtualised table own the scroll inside the
                page column instead of bleeding edge to edge. */}
            <Page.Content className="min-h-0">
                {!isLoading && filteredData.length === 0 ? (
                    <IssuesEmptyState
                        totalIssues={canAccessIssues.length}
                        hasCustomFilters={
                            JSON.stringify(filters) !==
                            JSON.stringify(DEFAULT_FILTERS)
                        }
                        onShowAll={() =>
                            setFilters({ condition: "and", items: [] })
                        }
                        onResetFilters={() => setFilters(DEFAULT_FILTERS)}
                    />
                ) : (
                    <IssuesDataTable
                        peek={peek}
                        data={filteredData}
                        loading={isLoading}
                    />
                )}
            </Page.Content>

            <IssueDetailsRightSheet issues={filteredData} />
        </Page.Root>
    );
}

/**
 * Card empty state in the same voice as the Reviews pages. Three cases:
 * nothing filed yet, filters hiding everything, or the default "open"
 * filter with every issue already resolved.
 */
function IssuesEmptyState({
    totalIssues,
    hasCustomFilters,
    onShowAll,
    onResetFilters,
}: {
    totalIssues: number;
    hasCustomFilters: boolean;
    onShowAll: () => void;
    onResetFilters: () => void;
}) {
    return (
        <div className="border-card-lv3/60 bg-card-lv1 flex flex-col items-center justify-center gap-3 rounded-xl border px-6 py-16 text-center">
            <div className="bg-card-lv2/60 text-text-tertiary flex size-11 items-center justify-center rounded-full">
                <TriangleAlertIcon aria-hidden className="size-5" />
            </div>
            {totalIssues === 0 ? (
                <p className="text-text-secondary max-w-sm text-sm text-pretty">
                    No issues yet. Problems Kody finds during reviews and that
                    are still open after the PR lands will show up here.
                </p>
            ) : hasCustomFilters ? (
                <>
                    <p className="text-text-secondary text-sm">
                        No issues match these filters.
                    </p>
                    <Button size="xs" variant="helper" onClick={onResetFilters}>
                        Reset filters
                    </Button>
                </>
            ) : (
                <>
                    <p className="text-text-secondary max-w-sm text-sm text-pretty">
                        No open issues. All {totalIssues} filed issue
                        {totalIssues === 1 ? " is" : "s are"} resolved.
                    </p>
                    <Button size="xs" variant="helper" onClick={onShowAll}>
                        Show resolved
                    </Button>
                </>
            )}
        </div>
    );
}
