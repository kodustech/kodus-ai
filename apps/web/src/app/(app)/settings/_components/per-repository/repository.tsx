"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import {
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubItem,
} from "@components/ui/sidebar";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useKodyRulesCount } from "@services/kodyRules/hooks";
import type { useSuspenseGetParameterPlatformConfigs } from "@services/parameters/hooks";
import { KodyLearningStatus } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useCustomMessagesOverrideCountsByRepository } from "@services/pull-request-messages/hooks";
import { ChevronDown, Plus, Search } from "lucide-react";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../../_hooks";
import { countConfigOverridesForRoutes } from "../../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type FormattedGlobalCodeReviewConfig,
} from "../../code-review/_types";
import { AddRepoModal } from "../copy-settings-modal";
import { RouteButtonWithOverrideCount } from "../route-button-with-override-count";
import { PerDirectoryGroup } from "./directory-group";
import { SidebarRepositoryOrDirectoryDropdown } from "./options-dropdown";

const RepositoryCollapsibleItem = ({
    repository,
    repositoryId,
    directoryId,
    pageName,
    routes,
}: {
    repository: FormattedGlobalCodeReviewConfig["repositories"][number];
    repositoryId: string;
    directoryId?: string;
    pageName: string;
    routes: Array<{ label: string; href: string }>;
}) => {
    const hasRepositoryConfig = repository.isSelected;
    const routeHrefs = routes.map((route) => route.href);

    const repositoryConfigOverrideCount = hasRepositoryConfig
        ? countConfigOverridesForRoutes(
              repository.configs,
              routeHrefs,
              FormattedConfigLevel.REPOSITORY,
          )
        : 0;

    const shouldFetchRepositoryCounts =
        hasRepositoryConfig || (repository.directories?.length ?? 0) > 0;

    const { data: repositoryOverrideCountsData } =
        useCustomMessagesOverrideCountsByRepository(
            repository.id,
            shouldFetchRepositoryCounts,
        );

    const repositoryKodyRulesCount = useKodyRulesCount(
        repository.id,
        undefined,
        shouldFetchRepositoryCounts,
    );

    const repositoryCustomMessagesOverrideCount = hasRepositoryConfig
        ? (repositoryOverrideCountsData?.repositoryOverrideCount ?? 0)
        : 0;

    const directoryCustomMessageCounts = new Map(
        (repositoryOverrideCountsData?.directoryOverrideCounts ?? []).map(
            (item) => [item.directoryId, item.overrideCount] as const,
        ),
    );

    const nestedDirectoryOverrideCount = (repository.directories ?? []).reduce(
        (total, directory) => {
            const directoryConfigOverrideCount = countConfigOverridesForRoutes(
                directory.configs,
                routeHrefs,
                FormattedConfigLevel.DIRECTORY,
            );

            return (
                total +
                directoryConfigOverrideCount +
                (directoryCustomMessageCounts.get(directory.id) ?? 0)
            );
        },
        0,
    );

    const overrideCount =
        repositoryConfigOverrideCount +
        repositoryCustomMessagesOverrideCount +
        repositoryKodyRulesCount +
        nestedDirectoryOverrideCount;

    return (
        <Collapsible
            key={repository.id}
            defaultOpen={repositoryId === repository.id}>
            <div className="flex items-center justify-between gap-2">
                <Tooltip disableHoverableContent>
                    <CollapsibleTrigger asChild>
                        <TooltipTrigger asChild>
                            <Button
                                size="md"
                                variant="helper"
                                className="h-fit flex-1 justify-start py-2"
                                leftIcon={
                                    <CollapsibleIndicator className="-ml-1 group-data-[state=closed]/collapsible:rotate-[-90deg] group-data-[state=open]/collapsible:rotate-0" />
                                }
                                rightIcon={
                                    overrideCount > 0 && (
                                        <Badge
                                            variant="primary-dark"
                                            className="h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                                            {overrideCount}
                                        </Badge>
                                    )
                                }>
                                <span className="line-clamp-1 truncate text-ellipsis">
                                    {repository.name}
                                </span>
                            </Button>
                        </TooltipTrigger>
                    </CollapsibleTrigger>

                    <TooltipContent side="right" className="text-sm">
                        {repository.name}
                        {overrideCount > 0 && (
                            <div className="text-text-tertiary mt-1 text-xs">
                                {overrideCount} config
                                {overrideCount !== 1 ? "s" : ""} overridden
                            </div>
                        )}
                    </TooltipContent>
                </Tooltip>

                {hasRepositoryConfig && (
                    <SidebarRepositoryOrDirectoryDropdown
                        repository={repository}
                    />
                )}
            </div>

            <CollapsibleContent>
                <SidebarMenuSub>
                    {hasRepositoryConfig &&
                        routes.map(({ label, href }) => {
                            const active =
                                repositoryId === repository.id &&
                                pageName === href &&
                                !directoryId;

                            return (
                                <SidebarMenuSubItem key={label}>
                                    <RouteButtonWithOverrideCount
                                        label={label}
                                        href={href}
                                        to={`/settings/code-review/${repository.id}/${href}`}
                                        active={active}
                                        level={FormattedConfigLevel.REPOSITORY}
                                        config={repository.configs}
                                        customMessagesOverrideCount={
                                            repositoryCustomMessagesOverrideCount
                                        }
                                        kodyRulesOverrideCount={
                                            repositoryKodyRulesCount
                                        }
                                    />
                                </SidebarMenuSubItem>
                            );
                        })}

                    {repository.directories?.map((group) => {
                        return (
                            <PerDirectoryGroup
                                key={group.id}
                                group={group}
                                repository={repository}
                                // Linked repositories is repo-scoped (#1576);
                                // directory-level saves for it would be wrong.
                                routes={routes.filter(
                                    (r) =>
                                        !("repoOnly" in r &&
                                            (r as { repoOnly?: boolean })
                                                .repoOnly),
                                )}
                                configs={group.configs}
                                customMessagesOverrideCount={
                                    directoryCustomMessageCounts.get(
                                        group.id,
                                    ) ?? 0
                                }
                            />
                        );
                    })}

                </SidebarMenuSub>
            </CollapsibleContent>
        </Collapsible>
    );
};

const REPOS_PAGE_SIZE = 25;
const SEARCH_MIN_CHARS = 4;

export const PerRepository = ({
    configValue,
    routes,
    platformConfig,
}: {
    configValue: FormattedGlobalCodeReviewConfig;
    platformConfig: ReturnType<typeof useSuspenseGetParameterPlatformConfigs>;
    routes: Array<{ label: string; href: string }>;
}) => {
    const { repositoryId, directoryId, pageName } = useCodeReviewRouteParams();
    const canCreate = usePermission(
        Action.Create,
        ResourceType.CodeReviewSettings,
    );

    const [search, setSearch] = useState("");
    const [visibleCount, setVisibleCount] = useState(REPOS_PAGE_SIZE);

    const configuredRepositories = useMemo(
        () =>
            safeArray(configValue?.repositories)
                .filter(
                    (repository) =>
                        repository.isSelected ||
                        (repository.directories?.length ?? 0) > 0,
                )
                .sort((a, b) =>
                    (a.name ?? "").localeCompare(b.name ?? "", undefined, {
                        sensitivity: "base",
                    }),
                ),
        [configValue?.repositories],
    );

    const query = search.trim().toLowerCase();
    const isSearching = query.length >= SEARCH_MIN_CHARS;

    const filteredRepositories = useMemo(() => {
        if (!isSearching) return configuredRepositories;

        return configuredRepositories.filter((repository) =>
            (repository.name ?? "").toLowerCase().includes(query),
        );
    }, [configuredRepositories, isSearching, query]);

    // Reset vertical pagination whenever the effective search changes.
    useEffect(() => {
        setVisibleCount(REPOS_PAGE_SIZE);
    }, [query]);

    const visibleRepositories = filteredRepositories.slice(0, visibleCount);
    const remaining = filteredRepositories.length - visibleRepositories.length;
    const canCollapse =
        visibleCount > REPOS_PAGE_SIZE &&
        filteredRepositories.length > REPOS_PAGE_SIZE;

    return (
        <SidebarMenuItem>
            <div className="pl-2">
                <div className="flex justify-between">
                    <div className="mb-4 flex flex-col gap-0.5">
                        <strong>Per repository</strong>
                        <span className="text-text-secondary text-xs">
                            Set custom configurations for each repository
                            (override global defaults).
                        </span>
                    </div>

                    <Button
                        size="icon-sm"
                        variant="secondary"
                        onClick={() => {
                            magicModal.show(() => (
                                <AddRepoModal
                                    repositories={configValue?.repositories}
                                />
                            ));
                        }}
                        disabled={
                            !canCreate ||
                            platformConfig.configValue.kodyLearningStatus ===
                                KodyLearningStatus.GENERATING_CONFIG
                        }>
                        <Plus />
                    </Button>
                </div>

                {configuredRepositories.length > 0 && (
                    <div className="mb-3">
                        <Input
                            size="md"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            leftIcon={<Search />}
                            placeholder="Search repositories…"
                        />
                    </div>
                )}
            </div>

            <div className="flex flex-col gap-1">
                {visibleRepositories.map((repository) => (
                    <RepositoryCollapsibleItem
                        key={repository.id}
                        repository={repository}
                        repositoryId={repositoryId}
                        directoryId={directoryId}
                        pageName={pageName}
                        routes={routes}
                    />
                ))}

                {isSearching && filteredRepositories.length === 0 && (
                    <div className="text-text-tertiary flex flex-col items-center gap-2 px-2 py-8 text-center">
                        <Search className="size-5 opacity-60" />
                        <span className="text-xs">
                            No repositories match “{search.trim()}”.
                        </span>
                    </div>
                )}

                {(remaining > 0 || canCollapse) && (
                    <div className="mt-2 flex flex-col gap-1.5 px-2">
                        {remaining > 0 && (
                            <Button
                                size="sm"
                                variant="helper"
                                className="w-full justify-center"
                                rightIcon={<ChevronDown />}
                                onClick={() =>
                                    setVisibleCount(
                                        (count) => count + REPOS_PAGE_SIZE,
                                    )
                                }>
                                Show {Math.min(remaining, REPOS_PAGE_SIZE)} more
                            </Button>
                        )}

                        <div className="flex items-center justify-between">
                            <span className="text-text-tertiary text-[11px]">
                                {visibleRepositories.length} of{" "}
                                {filteredRepositories.length}
                            </span>

                            {canCollapse && (
                                <Button
                                    size="xs"
                                    variant="cancel"
                                    onClick={() =>
                                        setVisibleCount(REPOS_PAGE_SIZE)
                                    }>
                                    Show less
                                </Button>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </SidebarMenuItem>
    );
};
