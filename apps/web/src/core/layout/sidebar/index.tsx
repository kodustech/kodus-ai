"use client";

/* Hallmark · component: side-rail nav · genre: modern-minimal · theme: system-tokens (card-lv*, text-*, primary-light)
 * states: default · hover · focus · active · current · disabled (locked) · collapsed rail
 * contrast: pass (40–41) · tokens: pass (48) · responsive: pass (34, 49) · icons: pass (30, lucide only)
 * pre-emit critique: P4 H4 E4 S4 R4 V4
 */
import {
    createContext,
    Suspense,
    useContext,
    useId,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import NextLink from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@components/ui/dropdown-menu";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import { Link } from "@components/ui/link";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { toast } from "@components/ui/toaster/use-toast";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    directoryScopeLabel,
    useCodeReviewScopes,
} from "@services/parameters/use-code-review-scopes";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import {
    ActivityIcon,
    BellIcon,
    BookOpenCheckIcon,
    Building2Icon,
    ChartColumnIcon,
    CheckIcon,
    ChevronRightIcon,
    ChevronsUpDownIcon,
    CogIcon,
    CreditCardIcon,
    FolderGit2Icon,
    FolderIcon,
    FolderTreeIcon,
    GaugeIcon,
    GlobeIcon,
    KeyRoundIcon,
    Link2Icon,
    LockIcon,
    MessageSquareTextIcon,
    PanelLeftCloseIcon,
    PanelLeftOpenIcon,
    PlusIcon,
    ScanSearchIcon,
    Settings2Icon,
    ShieldIcon,
    type LucideIcon,
} from "lucide-react";
import { useAllTeams } from "src/core/providers/all-teams-context";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { TEAM_STATUS } from "src/core/types";
import { cn } from "src/core/utils/components";
import { middleEllipsis } from "src/core/utils/middle-ellipsis";
import {
    hasUnsavedChanges,
    triggerNavigationBlock,
} from "src/core/utils/navigation-guard";
import { isEnterprisePlan } from "src/features/ee/byok/_utils";
import { useFeatureGates } from "src/features/ee/subscription/_hooks/use-feature-gates";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import { CommandPalette } from "../navbar/_components/command-palette";
import { NotificationBell } from "../navbar/_components/notification-bell";
import { UserNav } from "../navbar/_components/user-nav";
import { useMainNavItems } from "../navbar/use-main-nav-items";
import { SIDEBAR_COLLAPSED_COOKIE } from "./collapsed-cookie";
import { SidebarPlanStatus } from "./plan-status";
import { useScopeTools } from "./scope-tools";

/**
 * The app's navigation: every destination in one left rail, Cloudflare-
 * style — workspace and search on top, the product areas, code review
 * settings with its scope picker, the workspace's repositories and the
 * organization's settings, and the plan at the foot.
 *
 * Folds down to an icon rail (labels move into tooltips) and remembers that
 * in a cookie, so the server renders the chosen width on the first paint.
 */
const RailContext = createContext(false);
const useRail = () => useContext(RailContext);

// Every control in the rail: an instant keyboard ring (never faded in) and a
// pressed step one surface up. Links drop the DS link's focus underline for it.
const CONTROL_STATES =
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-card-lv3";

// Below a tablet width a 240px rail would take most of the screen, so the
// sidebar stays an icon rail there whatever the saved preference.
const NARROW_QUERY = "(max-width: 767px)";
const useIsNarrow = () =>
    useSyncExternalStore(
        (onChange) => {
            const query = window.matchMedia(NARROW_QUERY);
            query.addEventListener("change", onChange);
            return () => query.removeEventListener("change", onChange);
        },
        () => window.matchMedia(NARROW_QUERY).matches,
        () => false,
    );

export const AppSidebar = ({
    initialCollapsed = false,
}: {
    initialCollapsed?: boolean;
}) => {
    const pathname = usePathname();
    const mainItems = useMainNavItems();
    const [collapsedByChoice, setCollapsed] = useState(initialCollapsed);
    const isNarrow = useIsNarrow();
    const collapsed = collapsedByChoice || isNarrow;
    const toggle = () => {
        const next = !collapsed;
        setCollapsed(next);
        document.cookie = `${SIDEBAR_COLLAPSED_COOKIE}=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
    };

    const canReadCodeReviewSettings = usePermission(
        Action.Read,
        ResourceType.CodeReviewSettings,
    );
    const canReadRepositories = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );

    return (
        <RailContext.Provider value={collapsed}>
            <aside
                data-collapsed={collapsed}
                className={cn(
                    // Width snaps, never animates: a width transition reflows
                    // the whole page on every frame.
                    "bg-card-lv1 border-card-lv3/60 z-40 flex h-full shrink-0 flex-col overflow-hidden border-r",
                    collapsed ? "w-14" : "w-60",
                )}>
                <div
                    className={cn(
                        "flex flex-col gap-3 pt-4 pb-3",
                        collapsed ? "items-center px-2" : "px-3",
                    )}>
                    {collapsed ? (
                        <NextLink
                            href="/"
                            aria-label="Kodus home"
                            className="flex items-center">
                            {/* The mark alone: the first 40 units of the logo. */}
                            <SvgKodus
                                viewBox="0 0 40 40"
                                width="28"
                                className="h-7 min-h-7 w-7"
                            />
                        </NextLink>
                    ) : (
                        <NextLink href="/" className="flex items-center px-1">
                            <SvgKodus className="h-7 max-w-max" />
                        </NextLink>
                    )}
                    <WorkspaceSwitcher />
                    {collapsed ? (
                        <RailTooltip label="Search (⌘K)">
                            <span>
                                <CommandPalette variant="rail" />
                            </span>
                        </RailTooltip>
                    ) : (
                        <CommandPalette variant="sidebar" />
                    )}
                </div>

                <nav
                    aria-label="Main"
                    className={cn(
                        "flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-x-hidden overflow-y-auto pt-1 pb-4",
                        collapsed ? "gap-3 px-2" : "gap-5 px-3",
                    )}>
                    <ul className="flex flex-col gap-0.5">
                        {mainItems
                            .filter((item) => item.visible)
                            .map((item) => (
                                <SidebarItem
                                    key={item.id}
                                    href={item.href}
                                    icon={item.icon}
                                    label={item.label}
                                    badge={item.badge}
                                    attention={item.attention}
                                    active={
                                        item.matcher
                                            ? item.matcher(pathname)
                                            : pathname.startsWith(item.href)
                                    }
                                />
                            ))}
                    </ul>

                    {canReadCodeReviewSettings && (
                        <Suspense fallback={null}>
                            <CodeReviewGroup />
                        </Suspense>
                    )}

                    {canReadRepositories && (
                        <SidebarGroup label="Workspace">
                            <SidebarItem
                                href="/settings/git"
                                icon={FolderGit2Icon}
                                label="Repositories"
                                active={pathname.startsWith("/settings/git")}
                            />
                        </SidebarGroup>
                    )}

                    <OrganizationGroup />
                </nav>

                <div
                    className={cn(
                        "flex flex-col gap-1 px-2 pt-2 pb-1",
                        collapsed && "items-center",
                    )}>
                    <SidebarPlanStatus collapsed={collapsed} />
                    {!isNarrow && (
                        <RailTooltip label="Expand sidebar">
                            <button
                                type="button"
                                onClick={toggle}
                                aria-label={
                                    collapsed
                                        ? "Expand sidebar"
                                        : "Collapse sidebar"
                                }
                                aria-expanded={!collapsed}
                                className={cn(
                                    "text-text-tertiary hover:bg-card-lv2 hover:text-text-primary flex h-8 items-center gap-2.5 rounded-lg text-sm transition-colors",
                                    CONTROL_STATES,
                                    collapsed
                                        ? "w-9 justify-center"
                                        : "w-full px-2.5",
                                )}>
                                {collapsed ? (
                                    <PanelLeftOpenIcon className="size-4" />
                                ) : (
                                    <>
                                        <PanelLeftCloseIcon className="size-4" />
                                        Collapse
                                    </>
                                )}
                            </button>
                        </RailTooltip>
                    )}
                </div>

                <div
                    className={cn(
                        "border-card-lv3/60 flex gap-1 border-t px-2 py-2",
                        collapsed ? "flex-col items-center" : "items-center",
                    )}>
                    <div className={cn(!collapsed && "min-w-0 flex-1")}>
                        <UserNav variant={collapsed ? "rail" : "sidebar"} />
                    </div>
                    <NotificationBell />
                </div>
            </aside>
        </RailContext.Provider>
    );
};

/** A tooltip carrying the label that the collapsed rail no longer shows. */
const RailTooltip = ({
    label,
    alsoWhen = false,
    children,
}: {
    label: string;
    /** Show it in the open sidebar too, e.g. when a name was shortened. */
    alsoWhen?: boolean;
    children: React.ReactElement;
}) => {
    const collapsed = useRail();
    if (!collapsed && !alsoWhen) return children;

    return (
        // Hover waits so sweeping the pointer down the rail doesn't flash a
        // label per icon; keyboard focus shows it at once.
        <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
    );
};

const SidebarGroup = ({
    label,
    collapsible,
    active,
    children,
}: React.PropsWithChildren<{
    label: string;
    /** Folds the group away; it opens by itself while one of its pages is current. */
    collapsible?: boolean;
    active?: boolean;
}>) => {
    const [openByChoice, setOpenByChoice] = useState<boolean | undefined>();
    const open = !collapsible || (openByChoice ?? Boolean(active));
    const collapsed = useRail();
    const headingId = useId();

    if (collapsed) {
        return (
            <div className="flex flex-col gap-0.5">
                <div className="bg-card-lv3/60 mx-2 mb-1.5 h-px" aria-hidden />
                <ul aria-label={label} className="flex flex-col gap-0.5">
                    {children}
                </ul>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-1">
            {collapsible ? (
                <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenByChoice(!open)}
                    className={cn(
                        "text-text-tertiary hover:text-text-secondary flex items-center gap-1 rounded-md px-2.5 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors",
                        CONTROL_STATES,
                        "active:bg-transparent",
                    )}>
                    <span id={headingId} className="flex-1">
                        {label}
                    </span>
                    <ChevronRightIcon
                        aria-hidden
                        className={cn(
                            "size-3.5 transition-transform motion-reduce:transition-none",
                            open && "rotate-90",
                        )}
                    />
                </button>
            ) : (
                <span
                    id={headingId}
                    className="text-text-tertiary px-2.5 text-[11px] font-semibold tracking-wide uppercase">
                    {label}
                </span>
            )}
            {open && (
                <ul
                    aria-labelledby={headingId}
                    className="flex flex-col gap-0.5">
                    {children}
                </ul>
            )}
        </div>
    );
};

const SidebarItem = ({
    href,
    icon: Icon,
    label,
    active,
    badge,
    attention,
    locked,
}: {
    href: string;
    icon: LucideIcon;
    label: string;
    active: boolean;
    badge?: React.ReactNode;
    attention?: boolean;
    locked?: boolean;
}) => {
    const collapsed = useRail();

    return (
        <RailTooltip label={locked ? `${label} · higher plan` : label}>
            <li>
                <Link
                    href={href}
                    noHoverUnderline
                    aria-label={collapsed ? label : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                        "text-text-secondary hover:bg-card-lv2 hover:text-text-primary link-focused:no-underline flex h-8 w-full items-center gap-2.5 rounded-lg text-sm transition-colors",
                        CONTROL_STATES,
                        collapsed ? "relative h-9 justify-center" : "px-2.5",
                        active &&
                            "bg-card-lv2 text-text-primary [&>svg:first-child]:text-primary-light font-semibold",
                    )}>
                    <Icon
                        className="text-text-tertiary size-4 shrink-0"
                        aria-hidden
                    />
                    {collapsed && attention && (
                        <span
                            aria-hidden
                            className="bg-warning ring-card-lv1 absolute top-1.5 right-2 size-2 rounded-full ring-2"
                        />
                    )}
                    {!collapsed && (
                        <>
                            <span className="min-w-0 flex-1 truncate">
                                {label}
                            </span>
                            {badge}
                            {locked && (
                                <LockIcon
                                    aria-label="Higher plan"
                                    className="text-text-tertiary size-3.5 shrink-0"
                                />
                            )}
                        </>
                    )}
                </Link>
            </li>
        </RailTooltip>
    );
};

const WorkspaceSwitcher = () => {
    const { teams } = useAllTeams();
    const { teamId, setTeamId } = useSelectedTeamId();
    const current = teams.find((team) => team.uuid === teamId);
    const collapsed = useRail();

    const changeWorkspace = (nextTeamId: string) => {
        setTeamId(nextTeamId);
        const team = teams.find((item) => item.uuid === nextTeamId);
        toast({
            variant: "info",
            description: (
                <span>
                    Workspace changed to{" "}
                    <span className="text-primary-light font-bold">
                        {team?.name}
                    </span>
                </span>
            ),
        });
    };

    return (
        <DropdownMenu>
            <RailTooltip label={`Workspace: ${current?.name ?? ""}`}>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Workspace: ${current?.name ?? ""}. Change workspace`}
                        className={cn(
                            "bg-card-lv2 hover:bg-card-lv3 focus-visible:ring-ring flex items-center gap-2.5 rounded-lg text-left transition-colors focus:outline-none focus-visible:ring-2",
                            collapsed
                                ? "size-9 justify-center"
                                : "h-10 w-full px-2.5",
                        )}>
                        <span className="bg-primary-light/15 text-primary-light flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold uppercase">
                            {current?.name?.[0] ?? "?"}
                        </span>
                        {!collapsed && (
                            <>
                                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                                    <span className="text-text-tertiary text-[10px] font-semibold tracking-wide uppercase">
                                        Workspace
                                    </span>
                                    <span className="truncate text-sm font-semibold">
                                        {current?.name}
                                    </span>
                                </span>
                                <ChevronsUpDownIcon className="text-text-tertiary size-3.5 shrink-0" />
                            </>
                        )}
                    </button>
                </DropdownMenuTrigger>
            </RailTooltip>
            <DropdownMenuContent
                className="w-54"
                align="start"
                side={collapsed ? "right" : "bottom"}>
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                    value={teamId}
                    onValueChange={changeWorkspace}>
                    {teams.map((team) => (
                        <DropdownMenuRadioItem
                            key={team.uuid}
                            value={team.uuid}
                            disabled={team.status !== TEAM_STATUS.ACTIVE}>
                            {team.name}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

// Same pages, in the same order, as the settings tab band.
const CODE_REVIEW_PAGES: Array<{
    href: string;
    label: string;
    icon: LucideIcon;
    repoOnly?: boolean;
}> = [
    { href: "general", label: "General", icon: Settings2Icon },
    { href: "review-scope", label: "What to review", icon: ScanSearchIcon },
    { href: "kody-rules", label: "Kody Rules", icon: BookOpenCheckIcon },
    {
        href: "output",
        label: "What Kody writes",
        icon: MessageSquareTextIcon,
    },
    {
        href: "linked-repositories",
        label: "Linked repositories",
        icon: Link2Icon,
        // Relationships are directional and repo-scoped (#1576).
        repoOnly: true,
    },
];

type Scope = { repositoryId: string; directoryId?: string };

const CODE_REVIEW_PATH = /^\/settings\/code-review\/([^/]+)(?:\/([^/?#]+))?/;

const CodeReviewGroup = () => {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const collapsed = useRail();
    const scopeTools = useScopeTools();
    const match = CODE_REVIEW_PATH.exec(pathname);
    const scope: Scope = {
        repositoryId: match?.[1] ?? "global",
        directoryId: (match && searchParams.get("directoryId")) || undefined,
    };
    const currentPage = match?.[2];
    const isRepositoryLevel =
        scope.repositoryId !== "global" && !scope.directoryId;

    const hrefFor = (target: Scope, page: string) => {
        const base = `/settings/code-review/${target.repositoryId}/${page}`;
        return target.directoryId
            ? `${base}?directoryId=${target.directoryId}`
            : base;
    };

    return (
        <SidebarGroup label="Code review">
            <li className="mb-1 flex flex-col gap-1">
                <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                        <ScopeSelector
                            scope={scope}
                            pageFor={(target) => {
                                const targetIsRepository =
                                    target.repositoryId !== "global" &&
                                    !target.directoryId;
                                const page = CODE_REVIEW_PAGES.find(
                                    (item) => item.href === currentPage,
                                );
                                return page &&
                                    (!page.repoOnly || targetIsRepository)
                                    ? page.href
                                    : "general";
                            }}
                            hrefFor={hrefFor}
                        />
                    </div>
                    {/* The settings layout lends the scope's options menu here
                    and its kodus-config.yml badge below (scope-tools.tsx);
                    both empty on any other page and in the rail. */}
                    {!collapsed && (
                        <div
                            ref={scopeTools?.setActionsSlot}
                            className="flex shrink-0 items-center empty:hidden"
                        />
                    )}
                </div>
                {!collapsed && (
                    <div
                        ref={scopeTools?.setStatusSlot}
                        className="flex px-1 empty:hidden"
                    />
                )}
            </li>
            {CODE_REVIEW_PAGES.filter(
                (page) => !page.repoOnly || isRepositoryLevel,
            ).map((page) => (
                <SidebarItem
                    key={page.href}
                    href={hrefFor(scope, page.href)}
                    icon={page.icon}
                    label={page.label}
                    active={currentPage === page.href}
                />
            ))}
        </SidebarGroup>
    );
};

const ScopeSelector = ({
    scope,
    pageFor,
    hrefFor,
}: {
    scope: Scope;
    pageFor: (target: Scope) => string;
    hrefFor: (target: Scope, page: string) => string;
}) => {
    const router = useRouter();
    const collapsed = useRail();
    const [open, setOpen] = useState(false);
    const scopes = useCodeReviewScopes();
    // Only while a settings page lends it: creating a repository
    // configuration needs the full config those pages load.
    const addRepository = useScopeTools()?.addRepository;
    const canReadRepositories = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );

    // Only repositories with their own configuration are scopes, same filter
    // as the settings band's picker.
    const repositories = useMemo(
        () =>
            scopes
                .filter(
                    (item) =>
                        item.isSelected || (item.directories?.length ?? 0) > 0,
                )
                .sort((a, b) =>
                    (a.name ?? "").localeCompare(b.name ?? "", undefined, {
                        sensitivity: "base",
                    }),
                ),
        [scopes],
    );

    const repository = repositories.find(
        (item) => item.id === scope.repositoryId,
    );
    const directory = repository?.directories.find(
        (item) => item.id === scope.directoryId,
    );
    const name =
        scope.repositoryId === "global"
            ? "Global"
            : (repository?.name ?? "Repository");
    // A directory scope gets its own line: sharing one with the repository
    // name, the path — the part that tells two directories apart — was the
    // first thing the rail's width cut off.
    const path = directory ? directoryScopeLabel(directory) : undefined;
    const label = path ? `${name} ${path}` : name;
    const displayName = middleEllipsis(name, path ? 22 : 36);
    // The full name only needs a tooltip when some of it is hidden: the
    // middle cut, or a path long enough for the left clip to eat into.
    const shortened = displayName !== name || (path?.length ?? 0) > 24;
    const ScopeIcon =
        scope.repositoryId === "global"
            ? GlobeIcon
            : directory
              ? FolderTreeIcon
              : FolderIcon;

    const go = (href: string) => {
        setOpen(false);
        if (hasUnsavedChanges()) {
            triggerNavigationBlock();
            return;
        }
        router.push(href);
    };
    const goToScope = (target: Scope) => go(hrefFor(target, pageFor(target)));

    const isCurrent = (target: Scope) =>
        target.repositoryId === scope.repositoryId &&
        target.directoryId === scope.directoryId;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <RailTooltip
                label={collapsed ? `Scope: ${label}` : label}
                alsoWhen={shortened}>
                <PopoverTrigger asChild>
                    <button
                        type="button"
                        aria-label={`Settings scope: ${label}. Change scope`}
                        className={cn(
                            "border-card-lv3 hover:bg-card-lv2 focus-visible:ring-ring flex items-center gap-2 rounded-lg border text-left text-sm transition-colors focus:outline-none focus-visible:ring-2",
                            collapsed
                                ? "h-9 w-full justify-center"
                                : "min-h-8 w-full px-2.5 py-1",
                        )}>
                        <ScopeIcon
                            className="text-text-tertiary size-4 shrink-0"
                            aria-hidden
                        />
                        {!collapsed && (
                            <>
                                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                                    {/* A repository scope may take two lines,
                                        broken at its hyphens, and past that
                                        loses its middle, not an end: the
                                        start names the product, the end
                                        tells "kodus-service-billing" from
                                        "kodus-service-analytics". Beside a
                                        path it keeps one line. */}
                                    <span
                                        className={cn(
                                            "font-medium",
                                            path
                                                ? "truncate"
                                                : "line-clamp-2 [overflow-wrap:anywhere]",
                                        )}>
                                        {displayName}
                                    </span>
                                    {path && (
                                        // Clipped from the left, so a long path keeps
                                        // its last folder in view.
                                        <span className="text-text-tertiary truncate text-left font-mono text-[11px] [direction:rtl]">
                                            <bdi>{path}</bdi>
                                        </span>
                                    )}
                                </span>
                                <ChevronsUpDownIcon className="text-text-tertiary size-3.5 shrink-0" />
                            </>
                        )}
                    </button>
                </PopoverTrigger>
            </RailTooltip>
            <PopoverContent
                align="start"
                side="right"
                className="max-h-none w-[22rem] overflow-visible p-0">
                <Command>
                    <CommandInput placeholder="Search repositories and directories…" />
                    <CommandList>
                        <CommandEmpty>No repository matches.</CommandEmpty>
                        <CommandGroup heading="Scope">
                            <ScopeItem
                                value="global"
                                icon={GlobeIcon}
                                label="Global"
                                sublabel="applies to every repository"
                                selected={isCurrent({ repositoryId: "global" })}
                                onSelect={() =>
                                    goToScope({ repositoryId: "global" })
                                }
                            />
                        </CommandGroup>
                        <CommandGroup heading="Repositories">
                            {repositories.map((item) => (
                                <div key={item.id}>
                                    {item.isSelected && (
                                        <ScopeItem
                                            value={`repo-${item.id}`}
                                            keywords={[item.name]}
                                            icon={FolderIcon}
                                            label={item.name}
                                            selected={isCurrent({
                                                repositoryId: item.id,
                                            })}
                                            onSelect={() =>
                                                goToScope({
                                                    repositoryId: item.id,
                                                })
                                            }
                                        />
                                    )}
                                    {item.directories.map((dir) => (
                                        <ScopeItem
                                            key={dir.id}
                                            value={`dir-${dir.id}`}
                                            keywords={[
                                                item.name,
                                                ...(dir.paths ?? []),
                                            ]}
                                            icon={FolderTreeIcon}
                                            label={item.name}
                                            sublabel={directoryScopeLabel(dir)}
                                            indent={item.isSelected}
                                            selected={isCurrent({
                                                repositoryId: item.id,
                                                directoryId: dir.id,
                                            })}
                                            onSelect={() =>
                                                goToScope({
                                                    repositoryId: item.id,
                                                    directoryId: dir.id,
                                                })
                                            }
                                        />
                                    ))}
                                </div>
                            ))}
                        </CommandGroup>
                    </CommandList>
                    {(addRepository || canReadRepositories) && (
                        <>
                            <CommandSeparator className="bg-card-lv3" />
                            <div className="p-1">
                                {addRepository && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setOpen(false);
                                            addRepository();
                                        }}
                                        className={cn(
                                            "text-text-secondary hover:bg-card-lv2 hover:text-text-primary flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
                                            CONTROL_STATES,
                                        )}>
                                        <PlusIcon className="size-4 shrink-0" />
                                        Add repository configuration
                                    </button>
                                )}
                                {canReadRepositories && (
                                    <button
                                        type="button"
                                        onClick={() => go("/settings/git")}
                                        className={cn(
                                            "text-text-secondary hover:bg-card-lv2 hover:text-text-primary flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors",
                                            CONTROL_STATES,
                                        )}>
                                        <FolderGit2Icon className="size-4 shrink-0" />
                                        Choose which repositories Kody reviews
                                    </button>
                                )}
                            </div>
                        </>
                    )}
                </Command>
            </PopoverContent>
        </Popover>
    );
};

const ScopeItem = ({
    value,
    keywords,
    icon: Icon,
    label,
    sublabel,
    indent,
    selected,
    onSelect,
}: {
    value: string;
    keywords?: string[];
    icon: LucideIcon;
    label: string;
    sublabel?: string;
    indent?: boolean;
    selected: boolean;
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
            {/* The 70% cap only makes room for a path beside it. */}
            <span
                title={label}
                className={cn("truncate", sublabel && "max-w-[70%] shrink-0")}>
                {middleEllipsis(label, sublabel ? 24 : 40)}
            </span>
            {sublabel && (
                <span className="text-text-tertiary min-w-0 truncate font-mono text-[11px]">
                    {sublabel}
                </span>
            )}
        </span>
        {selected && (
            <CheckIcon
                className="text-primary-light size-4 shrink-0"
                aria-hidden
            />
        )}
    </CommandItem>
);

const OrganizationGroup = () => {
    const pathname = usePathname();
    const { license } = useSubscriptionContext();
    const gates = useFeatureGates();
    const canEditOrg = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    const canReadBilling = usePermission(Action.Read, ResourceType.Billing);
    const canReadLogs = usePermission(Action.Read, ResourceType.Logs);
    const canReadTokenUsage = usePermission(
        Action.Read,
        ResourceType.TokenUsage,
    );
    // Same rule as the organization sub-sidebar: listed on every plan, the
    // page shows the locked preview.
    const ssoLocked = !(
        isEnterprisePlan(license) || license.subscriptionStatus === "trial"
    );

    const items: Array<{
        href: string;
        label: string;
        icon: LucideIcon;
        visible: boolean;
        locked?: boolean;
    }> = [
        {
            href: "/organization/general",
            label: "General",
            icon: CogIcon,
            visible: canEditOrg,
        },
        {
            href: "/organization/sso",
            label: "SSO",
            icon: ShieldIcon,
            visible: canEditOrg,
            locked: ssoLocked,
        },
        {
            // "Cockpit" alone would read as a second link to the dashboard.
            href: "/organization/cockpit",
            label: "Cockpit visibility",
            icon: GaugeIcon,
            visible: canEditOrg,
        },
        {
            href: "/organization/cli-keys",
            label: "CLI keys",
            icon: KeyRoundIcon,
            visible: canEditOrg,
        },
        {
            href: "/organization/notifications",
            label: "Notifications",
            icon: BellIcon,
            visible: canEditOrg,
        },
        {
            href: "/settings/subscription",
            label: "Subscription",
            icon: CreditCardIcon,
            visible: canReadBilling,
        },
        {
            href: "/user-logs",
            label: "Activity logs",
            icon: ActivityIcon,
            visible: canReadLogs,
            locked: !gates.activityLogs,
        },
        {
            href: "/token-usage",
            label: "Token usage",
            icon: ChartColumnIcon,
            visible: canReadTokenUsage,
        },
    ];

    const visible = items.filter((item) => item.visible);
    const collapsed = useRail();
    if (visible.length === 0) return null;

    const isActive = visible.some((item) => pathname.startsWith(item.href));

    if (collapsed) {
        // Eight icons would outgrow a laptop screen; one opens them all.
        return (
            <div className="flex flex-col gap-0.5">
                <div className="bg-card-lv3/60 mx-2 mb-1.5 h-px" aria-hidden />
                <DropdownMenu>
                    <RailTooltip label="Organization">
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Organization settings"
                                className={cn(
                                    "text-text-secondary hover:bg-card-lv2 hover:text-text-primary flex h-9 w-full items-center justify-center rounded-lg transition-colors",
                                    CONTROL_STATES,
                                    isActive &&
                                        "bg-card-lv2 [&>svg]:text-primary-light",
                                )}>
                                <Building2Icon className="text-text-tertiary size-4" />
                            </button>
                        </DropdownMenuTrigger>
                    </RailTooltip>
                    <DropdownMenuContent
                        side="right"
                        align="end"
                        className="w-56">
                        <DropdownMenuLabel>Organization</DropdownMenuLabel>
                        {visible.map(({ icon: Icon, ...item }) => (
                            <NextLink key={item.href} href={item.href}>
                                <DropdownMenuItem leftIcon={<Icon />}>
                                    {item.label}
                                    {item.locked && (
                                        <LockIcon
                                            aria-label="Higher plan"
                                            className="text-text-tertiary ml-auto size-3.5"
                                        />
                                    )}
                                </DropdownMenuItem>
                            </NextLink>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        );
    }

    return (
        // Eight pages visited far less than the ones above: folded unless
        // you're on one, so the rail fits a laptop screen without scrolling.
        <SidebarGroup label="Organization" collapsible active={isActive}>
            {visible.map((item) => (
                <SidebarItem
                    key={item.href}
                    href={item.href}
                    icon={item.icon}
                    label={item.label}
                    locked={item.locked}
                    active={pathname.startsWith(item.href)}
                />
            ))}
        </SidebarGroup>
    );
};
