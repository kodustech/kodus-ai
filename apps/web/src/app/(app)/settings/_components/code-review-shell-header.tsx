"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from "@components/ui/command";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { Link } from "@components/ui/link";
import { magicModal } from "@components/ui/magic-modal";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { useKodyRulesCount } from "@services/kodyRules/hooks";
import {
    KodyLearningStatus,
    type PlatformConfigValue,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useCustomMessagesOverrideCountsByRepository } from "@services/pull-request-messages/hooks";
import {
    BookOpenCheckIcon,
    CheckIcon,
    ChevronDownIcon,
    FileTextIcon,
    FilterIcon,
    FolderIcon,
    FolderTreeIcon,
    GlobeIcon,
    Link2Icon,
    MessageCircleIcon,
    MessageSquareTextIcon,
    PlusIcon,
    ScanSearchIcon,
    Settings2Icon,
    TagsIcon,
} from "lucide-react";
import { cn } from "src/core/utils/components";
import {
    hasUnsavedChanges,
    triggerNavigationBlock,
} from "src/core/utils/navigation-guard";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../_hooks";
import {
    countConfigOverridesByRoute,
    countConfigOverridesForRoutes,
} from "../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";
import { AddRepoModal } from "./copy-settings-modal";
import { KodusConfigFileStatusBadge } from "./kodus-config-file-status";
import { SidebarRepositoryOrDirectoryDropdown } from "./per-repository/options-dropdown";
import { useCustomMessagesOverrideCount } from "./route-button-with-override-count";

export type SettingsRoute = {
    label: string;
    /** Compact label for the tabs header (falls back to `label`). */
    shortLabel?: string;
    href: string;
    repoOnly?: boolean;
};

type Repository = FormattedGlobalCodeReviewConfig["repositories"][number];
type Directory = NonNullable<Repository["directories"]>[number];
type ScopeTarget = { repositoryId: string; directoryId?: string };

// Same amber count pill the rail uses next to Global / each repository, so
// "this scope overrides N settings" reads the same in both shells. The
// title spells it out on hover.
// The page tabs must never scroll sideways: an invisible clone of the full
// row is measured, and only the tabs that fit stay inline — the rest fold
// into a "More" menu. The active tab is always kept inline (swapped in for
// the last fitting one) so the current page is never hidden in the menu.
const MORE_MENU_RESERVE_PX = 88;
const TAB_GAP_PX = 20;

const useFittingTabCount = (total: number) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const [fitting, setFitting] = useState(total);

    useEffect(() => {
        const container = containerRef.current;
        const measure = measureRef.current;
        if (!container || !measure) return;

        const compute = () => {
            const available = container.clientWidth;
            const widths = Array.from(measure.children).map(
                (el) => (el as HTMLElement).offsetWidth + TAB_GAP_PX,
            );
            const all = widths.reduce((sum, w) => sum + w, 0);
            if (all <= available) {
                setFitting(widths.length);
                return;
            }
            let used = 0;
            let fit = 0;
            for (const width of widths) {
                if (used + width + MORE_MENU_RESERVE_PX > available) break;
                used += width;
                fit += 1;
            }
            setFitting(Math.max(fit, 1));
        };

        compute();
        const observer = new ResizeObserver(compute);
        observer.observe(container);
        return () => observer.disconnect();
    }, [total]);

    return { containerRef, measureRef, fitting };
};

// One icon per settings page, same voice as the navbar (icon + label).
const PAGE_ICONS: Record<string, typeof FolderIcon> = {
    "general": Settings2Icon,
    "review-categories": TagsIcon,
    "review-scope": ScanSearchIcon,
    "output": MessageSquareTextIcon,
    "suggestion-control": FilterIcon,
    "custom-prompts": MessageSquareTextIcon,
    "pr-summary": FileTextIcon,
    "kody-rules": BookOpenCheckIcon,
    "custom-messages": MessageCircleIcon,
    "linked-repositories": Link2Icon,
};

// Tab that fills the band's height so its underline sits ON the band's
// bottom edge (GitHub repo-nav style) instead of floating under the label.
const TAB_CLASS =
    "group text-text-secondary hover:text-text-primary focus-visible:ring-ring relative -mb-px flex h-12 shrink-0 items-center gap-2 border-b-2 border-transparent px-1 text-sm font-medium whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 data-[active=true]:border-primary-light data-[active=true]:text-text-primary";

const SettingsTab = ({
    route,
    href,
    active,
    count,
}: {
    route: SettingsRoute;
    href: string;
    active: boolean;
    count: number;
}) => {
    const Icon = PAGE_ICONS[route.href] ?? FolderIcon;
    return (
        <NextLink
            href={href}
            // Full-route prefetch: the tab pages are client components over
            // the shared shell, so a switch is instant instead of a
            // round-trip.
            prefetch
            // Same guard as the DS Link: a tab switch with unsaved changes
            // scrolls to the dirty field instead of navigating.
            onClick={(event) => {
                if (hasUnsavedChanges()) {
                    event.preventDefault();
                    triggerNavigationBlock();
                }
            }}
            aria-current={active ? "page" : undefined}
            data-active={active ? "true" : undefined}
            className={TAB_CLASS}>
            <Icon
                className="text-text-tertiary group-data-[active=true]:text-primary-light size-4 shrink-0"
                aria-hidden
            />
            {route.shortLabel ?? route.label}
            <CountBadge count={count} />
        </NextLink>
    );
};

const CountBadge = ({ count }: { count: number }) =>
    count > 0 ? (
        <span
            title={`${count} setting${count === 1 ? "" : "s"} overridden at this level`}
            className="inline-flex">
            <Badge
                variant="primary-dark"
                className="pointer-events-none h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                {count}
            </Badge>
        </span>
    ) : null;

// Routes a scope can actually open. Global and directories never carry the
// repo-only pages (Linked Repositories is repo-scoped by design, #1576).
const routesForLevel = (routes: SettingsRoute[], level: FormattedConfigLevel) =>
    routes.filter(
        (route) => !route.repoOnly || level === FormattedConfigLevel.REPOSITORY,
    );

const levelFor = (target: ScopeTarget): FormattedConfigLevel =>
    target.repositoryId === "global"
        ? FormattedConfigLevel.GLOBAL
        : target.directoryId
          ? FormattedConfigLevel.DIRECTORY
          : FormattedConfigLevel.REPOSITORY;

const ScopeCommandItem = ({
    value,
    keywords,
    label,
    sublabel,
    icon: Icon,
    count,
    selected,
    indent,
    onSelect,
}: {
    value: string;
    keywords?: string[];
    label: string;
    sublabel?: string;
    icon: typeof FolderIcon;
    count: number;
    selected: boolean;
    indent?: boolean;
    onSelect: () => void;
}) => (
    <CommandItem
        value={value}
        keywords={keywords}
        onSelect={onSelect}
        aria-current={selected ? "true" : undefined}
        className={cn("min-h-8 gap-2 py-1.5 text-[13px]", indent && "pl-8")}>
        <Icon className="text-text-tertiary size-4 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
            {/* The name never gives way to its path: the mono sublabel
                truncates first. */}
            <span className="max-w-[70%] shrink-0 truncate">{label}</span>
            {sublabel && (
                <span className="text-text-tertiary min-w-0 truncate font-mono text-[11px]">
                    {sublabel}
                </span>
            )}
        </span>
        <CountBadge count={count} />
        {selected && (
            <CheckIcon
                className="text-primary-light size-4 shrink-0"
                aria-hidden
            />
        )}
    </CommandItem>
);

// One repository + its directories inside the switcher. Mirrors the rail's
// RepositoryCollapsibleItem arithmetic (config overrides + custom messages +
// Kody rules, directories included), with the same per-repo hooks.
const RepositoryScopeItems = ({
    repository,
    routes,
    current,
    onSelect,
}: {
    repository: Repository;
    routes: SettingsRoute[];
    current: ScopeTarget;
    onSelect: (target: ScopeTarget) => void;
}) => {
    const hasOwnConfig = repository.isSelected;
    const directories = repository.directories ?? [];
    const routeHrefs = routes.map((route) => route.href);
    const shouldFetch = hasOwnConfig || directories.length > 0;

    const { data: counts } = useCustomMessagesOverrideCountsByRepository(
        repository.id,
        shouldFetch,
    );
    const kodyRulesCount = useKodyRulesCount(
        repository.id,
        undefined,
        shouldFetch,
    );

    const directoryCustomMessages = new Map(
        (counts?.directoryOverrideCounts ?? []).map(
            (item) => [item.directoryId, item.overrideCount] as const,
        ),
    );

    const repositoryOwnCount = hasOwnConfig
        ? countConfigOverridesForRoutes(
              repository.configs,
              routeHrefs,
              FormattedConfigLevel.REPOSITORY,
          ) +
          (counts?.repositoryOverrideCount ?? 0) +
          kodyRulesCount
        : 0;

    return (
        <>
            {hasOwnConfig ? (
                <ScopeCommandItem
                    value={`repo:${repository.id}`}
                    keywords={[repository.name]}
                    label={repository.name}
                    icon={FolderIcon}
                    count={repositoryOwnCount}
                    selected={
                        current.repositoryId === repository.id &&
                        !current.directoryId
                    }
                    onSelect={() => onSelect({ repositoryId: repository.id })}
                />
            ) : (
                // Directory-only repository: the name is a group label, the
                // directories below are the selectable scopes.
                <div className="text-text-tertiary flex items-center gap-2 px-5 py-1.5 text-xs">
                    <FolderIcon className="size-3.5 shrink-0" aria-hidden />
                    {repository.name}
                </div>
            )}

            {directories.map((directory) => (
                <DirectoryScopeItem
                    key={directory.id}
                    repository={repository}
                    directory={directory}
                    routes={routes}
                    customMessagesCount={
                        directoryCustomMessages.get(directory.id) ?? 0
                    }
                    selected={
                        current.repositoryId === repository.id &&
                        current.directoryId === directory.id
                    }
                    onSelect={onSelect}
                />
            ))}
        </>
    );
};

const DirectoryScopeItem = ({
    repository,
    directory,
    routes,
    customMessagesCount,
    selected,
    onSelect,
}: {
    repository: Repository;
    directory: Directory;
    routes: SettingsRoute[];
    customMessagesCount: number;
    selected: boolean;
    onSelect: (target: ScopeTarget) => void;
}) => {
    const kodyRulesCount = useKodyRulesCount(repository.id, directory.id);
    const folders = directory.folders ?? [];
    const path = folders[0]?.path ?? directory.name;
    const count =
        countConfigOverridesForRoutes(
            directory.configs,
            routesForLevel(routes, FormattedConfigLevel.DIRECTORY).map(
                (route) => route.href,
            ),
            FormattedConfigLevel.DIRECTORY,
        ) +
        customMessagesCount +
        kodyRulesCount;

    return (
        <ScopeCommandItem
            value={`dir:${repository.id}:${directory.id}`}
            keywords={[repository.name, ...folders.map((f) => f.path)]}
            label={repository.name}
            sublabel={
                folders.length > 1 ? `${path} +${folders.length - 1}` : path
            }
            icon={FolderTreeIcon}
            count={count}
            selected={selected}
            indent
            onSelect={() =>
                onSelect({
                    repositoryId: repository.id,
                    directoryId: directory.id,
                })
            }
        />
    );
};

/**
 * Header of the `settings-tabs-shell` (alpha) for /settings/code-review/*:
 * the scope switcher (Global · repositories · directories) is the page's
 * identity on the first row, the page nav sits on the second. Replaces the
 * rail's tree + the breadcrumb, so the page below no longer restates where
 * the user is.
 */
export const CodeReviewShellHeader = ({
    configValue,
    platformConfigValue,
    routes,
    globalOverrideCount,
}: {
    configValue: FormattedGlobalCodeReviewConfig;
    platformConfigValue: PlatformConfigValue;
    routes: SettingsRoute[];
    globalOverrideCount: number;
}) => {
    const router = useRouter();
    const { repositoryId, directoryId, pageName } = useCodeReviewRouteParams();
    const canCreate = usePermission(
        Action.Create,
        ResourceType.CodeReviewSettings,
    );
    const [open, setOpen] = useState(false);

    const current: ScopeTarget = {
        repositoryId: repositoryId || "global",
        directoryId,
    };
    const isGlobal = current.repositoryId === "global";
    const repository = isGlobal
        ? undefined
        : safeArray(configValue.repositories).find(
              (item) => item.id === current.repositoryId,
          );
    const directory = directoryId
        ? repository?.directories?.find((item) => item.id === directoryId)
        : undefined;
    const level = levelFor({
        repositoryId: current.repositoryId,
        directoryId: directory?.id,
    });
    const scopeConfig = isGlobal
        ? configValue.configs
        : directory
          ? directory.configs
          : repository?.configs;
    const scopeLabel = isGlobal
        ? "Global"
        : directory
          ? `${repository?.name ?? ""}${directory.folders?.[0]?.path ?? ""}`
          : (repository?.name ?? current.repositoryId);
    const ScopeIcon = isGlobal
        ? GlobeIcon
        : directory
          ? FolderTreeIcon
          : FolderIcon;

    // Per-route counts for the CURRENT scope — same arithmetic as the rail's
    // RouteButtonWithOverrideCount. Hooks stay unconditional; `enabled`
    // gates the fetches to the scope that needs them.
    const globalCustomMessagesCount = useCustomMessagesOverrideCount({
        scopeRepositoryId: "global",
        level: FormattedConfigLevel.GLOBAL,
        enabled: isGlobal,
    });
    const { data: repositoryCounts } =
        useCustomMessagesOverrideCountsByRepository(
            repository?.id ?? "global",
            !!repository,
        );
    const kodyRulesCount = useKodyRulesCount(
        repository?.id ?? "global",
        directory?.id,
        !!repository,
    );
    const customMessagesCount = isGlobal
        ? globalCustomMessagesCount
        : directory
          ? (repositoryCounts?.directoryOverrideCounts?.find(
                (item) => item.directoryId === directory.id,
            )?.overrideCount ?? 0)
          : (repositoryCounts?.repositoryOverrideCount ?? 0);

    const visibleRoutes = routesForLevel(routes, level);
    const { containerRef, measureRef, fitting } = useFittingTabCount(
        visibleRoutes.length,
    );
    const { inlineRoutes, overflowRoutes } = (() => {
        if (fitting >= visibleRoutes.length) {
            return { inlineRoutes: visibleRoutes, overflowRoutes: [] };
        }
        const activeIndex = visibleRoutes.findIndex(
            (route) => route.href === pageName,
        );
        let inline = visibleRoutes.slice(0, fitting);
        let overflow = visibleRoutes.slice(fitting);
        if (activeIndex >= fitting) {
            // Keep the current page inline: it takes the last inline slot.
            const active = visibleRoutes[activeIndex];
            const bumped = inline[inline.length - 1];
            inline = [...inline.slice(0, -1), active];
            overflow = [
                bumped,
                ...overflow.filter((route) => route.href !== active.href),
            ];
        }
        return { inlineRoutes: inline, overflowRoutes: overflow };
    })();
    const countFor = (href: string) => {
        const configCount =
            countConfigOverridesByRoute(scopeConfig, href, level) ?? 0;
        if (href === "custom-messages") return customMessagesCount;
        if (href === "output") return configCount + customMessagesCount;
        if (href === "kody-rules") {
            return configCount + (repository ? kodyRulesCount : 0);
        }
        return configCount;
    };
    const scopeOverrideCount = visibleRoutes.reduce(
        (total, route) => total + countFor(route.href),
        0,
    );

    // Keep the user on the same page when the scope changes, unless that
    // page doesn't exist at the target level (then land on General).
    const hrefFor = (target: ScopeTarget) => {
        const allowed = routesForLevel(routes, levelFor(target));
        const page = allowed.some((route) => route.href === pageName)
            ? pageName
            : "general";
        const base = `/settings/code-review/${target.repositoryId}/${page}`;
        return target.directoryId
            ? `${base}?directoryId=${target.directoryId}`
            : base;
    };
    const pageHref = (href: string) => {
        const base = `/settings/code-review/${current.repositoryId}/${href}`;
        return directory ? `${base}?directoryId=${directory.id}` : base;
    };
    const goTo = (target: ScopeTarget) => {
        setOpen(false);
        if (hasUnsavedChanges()) {
            triggerNavigationBlock();
            return;
        }
        router.push(hrefFor(target));
    };

    const configuredRepositories = useMemo(
        () =>
            safeArray(configValue.repositories)
                .filter(
                    (item) =>
                        item.isSelected || (item.directories?.length ?? 0) > 0,
                )
                .sort((a, b) =>
                    (a.name ?? "").localeCompare(b.name ?? "", undefined, {
                        sensitivity: "base",
                    }),
                ),
        [configValue.repositories],
    );

    const canAddRepository =
        canCreate &&
        platformConfigValue.kodyLearningStatus !==
            KodyLearningStatus.GENERATING_CONFIG;
    const openAddRepository = () => {
        setOpen(false);
        magicModal.show(() => (
            <AddRepoModal repositories={configValue.repositories} />
        ));
    };

    return (
        // The band is a surface of its own (same tone as the navbar, hairline
        // below), like a GitHub repo header: scope pill on the left, page
        // tabs with icons after it, active underline flush with the edge.
        <div className="bg-card-lv1 border-card-lv3/60 shrink-0 border-b px-8">
            <div className="mx-auto flex h-12 w-full max-w-7xl items-stretch gap-6">
                <div className="flex shrink-0 items-center gap-1.5">
                    <Popover open={open} onOpenChange={setOpen}>
                        <PopoverTrigger asChild>
                            <button
                                type="button"
                                aria-label={`Settings scope: ${scopeLabel}. Change scope`}
                                className="bg-card-lv2 hover:bg-card-lv3 text-text-primary focus-visible:ring-ring flex h-8 max-w-[22rem] items-center gap-2 rounded-lg pr-2 pl-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2">
                                <ScopeIcon
                                    className="text-text-tertiary size-4 shrink-0"
                                    aria-hidden
                                />
                                <span className="truncate">{scopeLabel}</span>
                                <CountBadge count={scopeOverrideCount} />
                                <ChevronDownIcon
                                    className="text-text-tertiary size-3.5 shrink-0"
                                    aria-hidden
                                />
                            </button>
                        </PopoverTrigger>

                        <PopoverContent
                            align="start"
                            // The DS popover scrolls at 300px and so does the
                            // CommandList inside it; only the list should.
                            className="max-h-none w-[26rem] overflow-visible p-0">
                            <Command>
                                <CommandInput placeholder="Search repositories and directories…" />
                                <CommandList>
                                    <CommandEmpty>
                                        No repository matches.
                                    </CommandEmpty>
                                    <CommandGroup heading="Scope">
                                        <ScopeCommandItem
                                            value="global"
                                            keywords={["global", "default"]}
                                            label="Global"
                                            sublabel="applies to every repository"
                                            icon={GlobeIcon}
                                            count={globalOverrideCount}
                                            selected={isGlobal}
                                            onSelect={() =>
                                                goTo({ repositoryId: "global" })
                                            }
                                        />
                                    </CommandGroup>
                                    <CommandGroup heading="Repositories">
                                        {configuredRepositories.length ===
                                            0 && (
                                            <div className="text-text-tertiary px-5 py-3 text-xs">
                                                No repository has its own
                                                configuration yet.
                                            </div>
                                        )}
                                        {configuredRepositories.map((item) => (
                                            <RepositoryScopeItems
                                                key={item.id}
                                                repository={item}
                                                routes={routes}
                                                current={current}
                                                onSelect={goTo}
                                            />
                                        ))}
                                    </CommandGroup>
                                </CommandList>
                                {canAddRepository && (
                                    <>
                                        <CommandSeparator className="bg-card-lv3" />
                                        <div className="p-1">
                                            <Button
                                                size="sm"
                                                variant="cancel"
                                                className="w-full justify-start"
                                                leftIcon={<PlusIcon />}
                                                onClick={openAddRepository}>
                                                Add repository configuration
                                            </Button>
                                        </div>
                                    </>
                                )}
                            </Command>
                        </PopoverContent>
                    </Popover>

                    {repository && (
                        <SidebarRepositoryOrDirectoryDropdown
                            repository={repository}
                            directory={
                                directory
                                    ? {
                                          id: directory.id,
                                          name: directory.name,
                                          folders: directory.folders,
                                      }
                                    : undefined
                            }
                        />
                    )}

                    <KodusConfigFileStatusBadge />
                </div>

                <div ref={containerRef} className="relative min-w-0 flex-1">
                    {/* Measurement clone — never visible, never interactive. */}
                    <div
                        ref={measureRef}
                        aria-hidden
                        className="pointer-events-none invisible absolute inset-x-0 top-0 flex h-12 items-center gap-5 whitespace-nowrap">
                        {visibleRoutes.map((route) => (
                            <SettingsTab
                                key={route.href}
                                route={route}
                                href={pageHref(route.href)}
                                active={false}
                                count={countFor(route.href)}
                            />
                        ))}
                    </div>

                    <nav
                        aria-label="Code review settings pages"
                        className="flex h-12 items-stretch gap-5 overflow-hidden">
                        {inlineRoutes.map((route) => (
                            <SettingsTab
                                key={route.href}
                                route={route}
                                href={pageHref(route.href)}
                                active={pageName === route.href}
                                count={countFor(route.href)}
                            />
                        ))}

                        {overflowRoutes.length > 0 && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button type="button" className={TAB_CLASS}>
                                        More
                                        <ChevronDownIcon
                                            className="text-text-tertiary size-3.5"
                                            aria-hidden
                                        />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent
                                    align="end"
                                    className="w-56">
                                    {overflowRoutes.map((route) => {
                                        const Icon =
                                            PAGE_ICONS[route.href] ??
                                            FolderIcon;
                                        return (
                                            <Link
                                                key={route.href}
                                                href={pageHref(route.href)}
                                                noHoverUnderline
                                                className="w-full text-inherit">
                                                <DropdownMenuItem
                                                    className="justify-between"
                                                    leftIcon={<Icon />}>
                                                    {route.label}
                                                    <CountBadge
                                                        count={countFor(
                                                            route.href,
                                                        )}
                                                    />
                                                </DropdownMenuItem>
                                            </Link>
                                        );
                                    })}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </nav>
                </div>
            </div>
        </div>
    );
};
