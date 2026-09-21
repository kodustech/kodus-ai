"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
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
import { Dialog, DialogContent } from "@components/ui/dialog";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import {
    directoryScopeLabel,
    rulePageHref,
    useCodeReviewScopes,
} from "@services/parameters/use-code-review-scopes";
import { useQuery } from "@tanstack/react-query";
import {
    ActivityIcon,
    BellIcon,
    BookOpenIcon,
    Building2Icon,
    ChartColumnIcon,
    CreditCardIcon,
    FolderGit2Icon,
    FolderIcon,
    FolderTreeIcon,
    GaugeIcon,
    GitPullRequestIcon,
    GlobeIcon,
    KeyRoundIcon,
    LockIcon,
    MessageSquareTextIcon,
    PuzzleIcon,
    ScanSearchIcon,
    ScrollTextIcon,
    SearchIcon,
    SettingsIcon,
    ShieldIcon,
    SparklesIcon,
    TerminalIcon,
    TriangleAlertIcon,
} from "lucide-react";
import {
    hasUnsavedChanges,
    triggerNavigationBlock,
} from "src/core/utils/navigation-guard";
import { useFetch } from "src/core/utils/reactQuery";
import {
    GATE_PLAN_LABEL,
    useFeatureGates,
    type GatedFeatureKey,
} from "src/features/ee/subscription/_hooks/use-feature-gates";
import { Action, ResourceType } from "@services/permissions/types";
import { useAuth } from "src/core/providers/auth.provider";
import { usePermissions } from "src/core/providers/permissions.provider";
import { hasPermission } from "src/core/utils/permission-map";

// ⌘K palette (prototype): one search box that jumps to any page, switches
// the settings scope to a repository or directory, opens a Kody Rule by
// title, or searches pull requests by number/title. Built on the DS Command
// (cmdk); data is fetched lazily, only once the palette opens.

const PAGES: Array<{
    label: string;
    href: string;
    icon: ComponentType<{ className?: string }>;
    keywords: string;
    gate?: GatedFeatureKey;
    /** RBAC for the destination. A plan `gate` decides whether the feature is
     *  SOLD to this organization; this decides whether this ROLE may open it.
     *  Without it the palette offered pages the navbar had already hidden. */
    permission?: { action: Action; resource: ResourceType };
}> = [
    {
        label: "Pull requests",
        href: "/pull-requests",
        icon: GitPullRequestIcon,
        keywords: "reviews prs",
        permission: { action: Action.Read, resource: ResourceType.PullRequests },
    },
    {
        label: "CLI reviews",
        href: "/cli-reviews",
        icon: TerminalIcon,
        keywords: "reviews cli terminal",
        permission: { action: Action.Read, resource: ResourceType.CliReview },
    },
    {
        label: "Cockpit",
        href: "/cockpit",
        icon: GaugeIcon,
        keywords: "metrics analytics dashboard productivity",
        gate: "cockpit",
        permission: { action: Action.Read, resource: ResourceType.Cockpit },
    },
    {
        label: "Issues",
        href: "/issues",
        icon: TriangleAlertIcon,
        keywords: "cockpit open resolved",
        gate: "cockpit",
        permission: { action: Action.Read, resource: ResourceType.Issues },
    },
    {
        label: "Plugins",
        href: "/settings/plugins",
        icon: PuzzleIcon,
        keywords: "mcp integrations tools",
        permission: { action: Action.Read, resource: ResourceType.PluginSettings },
    },
    {
        label: "Repositories",
        href: "/settings/git",
        icon: FolderGit2Icon,
        keywords:
            "git settings integrations provider connection github gitlab bitbucket azure forgejo",
        permission: { action: Action.Read, resource: ResourceType.GitSettings },
    },
    {
        label: "Rules library",
        href: "/library/kody-rules",
        icon: BookOpenIcon,
        keywords: "marketplace kody rules packs",
    },
    {
        label: "AI providers",
        href: "/byok",
        icon: SparklesIcon,
        keywords: "byok bring your own key api key model provider llm",
    },
    // The page's own tabs, so "routing" and "credits" land on the panel that
    // answers them instead of the tab the page happens to open on.
    {
        label: "AI providers · Routing",
        href: "/byok?tab=routing",
        icon: SparklesIcon,
        keywords: "which model runs each task default fallback per agent",
    },
    {
        label: "AI providers · Budget",
        href: "/byok?tab=budget",
        icon: SparklesIcon,
        keywords: "spend limit alerts monthly cap credits top up balance",
    },
    {
        label: "Subscription",
        href: "/settings/subscription",
        icon: CreditCardIcon,
        keywords: "billing plan licenses seats",
        permission: { action: Action.Read, resource: ResourceType.Billing },
    },
    {
        label: "Token usage",
        href: "/token-usage",
        icon: ChartColumnIcon,
        keywords: "cost spend tokens",
        permission: { action: Action.Read, resource: ResourceType.TokenUsage },
    },
    {
        label: "Activity logs",
        href: "/user-logs",
        icon: ActivityIcon,
        keywords: "audit history",
        gate: "activityLogs",
        permission: { action: Action.Read, resource: ResourceType.Logs },
    },
    {
        label: "Organization · General",
        href: "/organization/general",
        icon: Building2Icon,
        keywords: "org timezone auto join",
    },
    {
        label: "Organization · SSO",
        href: "/organization/sso",
        icon: ShieldIcon,
        keywords: "saml okta login",
        gate: "sso",
    },
    {
        label: "Organization · Cockpit",
        href: "/organization/cockpit",
        icon: GaugeIcon,
        keywords: "metrics visibility",
    },
    {
        label: "Organization · CLI keys",
        href: "/organization/cli-keys",
        icon: KeyRoundIcon,
        keywords: "api token cli",
    },
    {
        label: "Organization · Notifications",
        href: "/organization/notifications",
        icon: BellIcon,
        keywords: "email alerts",
    },
];

const SETTINGS_TABS = [
    {
        label: "General",
        href: "general",
        icon: SettingsIcon,
        keywords: "code review settings automated approval",
    },
    {
        label: "What to review",
        href: "review-scope",
        icon: ScanSearchIcon,
        keywords: "categories severity instructions",
    },
    {
        label: "Kody Rules",
        href: "kody-rules",
        icon: ScrollTextIcon,
        keywords: "rules memories",
    },
    {
        label: "What Kody writes",
        href: "output",
        icon: MessageSquareTextIcon,
        keywords: "summary comments personality prompts",
    },
    {
        label: "Custom prompts",
        href: "custom-prompts",
        icon: MessageSquareTextIcon,
        keywords: "prompt overrides",
    },
    {
        label: "Custom messages",
        href: "custom-messages",
        icon: MessageSquareTextIcon,
        keywords: "review start end error comments",
    },
    {
        label: "PR summary",
        href: "pr-summary",
        icon: MessageSquareTextIcon,
        keywords: "description summary",
    },
];

/** What /kody-rules/index returns per rule. */
type KodyRuleIndexEntry = {
    uuid: string;
    title: string;
    repositoryId: string;
    directoryId?: string;
    type?: string;
};

const settingsHref = (
    repositoryId: string,
    page: string,
    directoryId?: string,
) => {
    const base = `/settings/code-review/${repositoryId}/${page}`;
    return directoryId ? `${base}?directoryId=${directoryId}` : base;
};

// cmdk's default fuzzy match lets "sso" hit "Issues" and half the rules.
// Every word typed has to appear literally in the item's value (label +
// keywords); earlier matches rank first.
const filterItems = (value: string, search: string) => {
    const haystack = value.toLowerCase();
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return 1;
    let score = 0;
    for (const word of words) {
        const index = haystack.indexOf(word);
        if (index < 0) return 0;
        score += 1 / (index + 1);
    }
    return score;
};

// Rank a list in memory and keep only the best `limit` entries, so a big org
// (thousands of rules, hundreds of repositories) never mounts more than a
// handful of items per group. `filterItems` is what cmdk uses for the static
// entries; this applies the same rule before rendering.
const topMatches = <T,>(
    items: T[],
    valueOf: (item: T) => string,
    search: string,
    limit: number,
): T[] => {
    if (!search.trim()) return items.slice(0, limit);
    return items
        .map((item) => ({ item, score: filterItems(valueOf(item), search) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => entry.item);
};

export const CommandPalette = ({
    variant = "navbar",
}: {
    /**
     * "sidebar": a full-width search field at the top of the sidebar nav;
     * "rail": its icon-only form when the sidebar is collapsed.
     */
    variant?: "navbar" | "sidebar" | "rail";
}) => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const router = useRouter();
    const gates = useFeatureGates();

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "k"
            ) {
                event.preventDefault();
                setQuery("");
                setOpen((value) => !value);
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    // Projected index: id, title and scope. The full listing carries every
    // rule's body, examples and detector — megabytes on a large org, and the
    // palette only shows titles.
    const { data: rules } = useFetch<Array<KodyRuleIndexEntry>>(
        KODY_RULES_PATHS.INDEX,
        undefined,
        open,
        { staleTime: 60_000 },
    );
    const scopes = useCodeReviewScopes(open);

    // RBAC, on top of the plan gates. A gated page stays listed with a
    // padlock because the organization could buy it; a page this ROLE cannot
    // open is not listed at all, which is what the navbar already does.
    // Without this the palette was a way around the navbar's own filtering.
    const permissions = usePermissions();
    const { organizationId } = useAuth();
    const visiblePages = useMemo(
        () =>
            PAGES.filter(
                (page) =>
                    !page.permission ||
                    hasPermission({
                        permissions,
                        organizationId: organizationId!,
                        action: page.permission.action,
                        resource: page.permission.resource,
                    }),
            ),
        [permissions, organizationId],
    );

    // MCP plugins (Jira, Linear, …): each opens its own page. Empty when the
    // MCP manager is not reachable.
    const { data: plugins } = useQuery({
        queryKey: ["command-palette", "mcp-plugins"],
        queryFn: () => getMCPPlugins().catch(() => []),
        enabled: open,
        staleTime: 60_000,
    });

    const repositories = useMemo(
        () =>
            scopes.filter(
                (scope) =>
                    scope.isSelected || (scope.directories?.length ?? 0) > 0,
            ),
        [scopes],
    );

    // Repository ids the settings shell can actually open, and their names.
    const scopeNames = useMemo(
        () => new Map(scopes.map((scope) => [scope.id, scope.name])),
        [scopes],
    );

    // Only rules the settings screen can actually show: global ones, and
    // ones whose repository is still configured. A rule can outlive its
    // scope's configuration (repository removed, rules imported from
    // elsewhere), and no page lists those — offering them here would be a
    // dead end.
    const openableRules = useMemo(
        () =>
            (rules ?? []).filter(
                (rule) =>
                    !rule.repositoryId ||
                    rule.repositoryId === "global" ||
                    scopeNames.has(rule.repositoryId),
            ),
        [rules, scopeNames],
    );
    const matchedRules = useMemo(
        () =>
            topMatches(openableRules, (rule) => `rule ${rule.title}`, query, 8),
        [openableRules, query],
    );
    const matchedRepositories = useMemo(() => {
        const entries = repositories.flatMap((repo) => [
            {
                key: repo.id,
                repo,
                directory: undefined as
                    (typeof repo.directories)[number] | undefined,
                value: `repo ${repo.name}`,
            },
            ...(repo.directories ?? []).map((directory) => ({
                key: directory.id,
                repo,
                directory,
                value: `directory ${repo.name} ${directoryScopeLabel(directory)}`,
            })),
        ]);
        return topMatches(entries, (entry) => entry.value, query, 10);
    }, [repositories, query]);

    const go = (href: string) => {
        setOpen(false);
        if (hasUnsavedChanges()) {
            triggerNavigationBlock();
            return;
        }
        router.push(href);
    };

    const trimmed = query.trim();
    const prNumber = /^#?(\d{1,7})$/.exec(trimmed)?.[1];

    return (
        <>
            {variant === "rail" ? (
                <button
                    type="button"
                    aria-label="Search and jump anywhere (⌘K)"
                    onClick={() => setOpen(true)}
                    className="bg-card-lv2 hover:bg-card-lv3 text-text-tertiary focus-visible:ring-ring flex size-9 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2">
                    <SearchIcon className="size-4" />
                </button>
            ) : variant === "sidebar" ? (
                <button
                    type="button"
                    aria-label="Search and jump anywhere (⌘K)"
                    onClick={() => setOpen(true)}
                    className="bg-card-lv2 hover:bg-card-lv3 text-text-tertiary focus-visible:ring-ring flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-sm transition-colors focus:outline-none focus-visible:ring-2">
                    <SearchIcon className="size-4 shrink-0" />
                    <span className="flex-1 text-left">Search</span>
                    <kbd className="bg-card-lv3/70 rounded px-1.5 py-0.5 font-mono text-[10px]">
                        ⌘K
                    </kbd>
                </button>
            ) : (
                <Button
                    size="xs"
                    variant="helper"
                    aria-label="Search and jump anywhere (⌘K)"
                    leftIcon={<SearchIcon />}
                    onClick={() => setOpen(true)}>
                    <span className="hidden lg:inline">Search</span>
                    <kbd className="bg-card-lv3/70 text-text-tertiary ml-1 hidden rounded px-1.5 py-0.5 font-mono text-[10px] lg:inline">
                        ⌘K
                    </kbd>
                </Button>
            )}

            <Dialog
                open={open}
                onOpenChange={(value) => {
                    setQuery("");
                    setOpen(value);
                }}>
                <DialogContent className="overflow-hidden p-0 shadow-lg">
                    <Command
                        filter={filterItems}
                        className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:size-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:size-5">
                        <CommandInput
                            placeholder="Jump to a page, repository, rule or PR…"
                            value={query}
                            onValueChange={setQuery}
                        />
                        <CommandList className="max-h-[60vh]">
                            <CommandEmpty>Nothing matches.</CommandEmpty>

                            {prNumber && (
                                <CommandGroup heading="Pull request">
                                    <CommandItem
                                        value={`${trimmed} pull request ${prNumber}`}
                                        onSelect={() =>
                                            go(
                                                `/pull-requests?by=number&q=${prNumber}`,
                                            )
                                        }>
                                        <GitPullRequestIcon />
                                        <span className="min-w-0 flex-1 truncate">
                                            Open pull request #{prNumber}
                                        </span>
                                    </CommandItem>
                                </CommandGroup>
                            )}

                            <CommandGroup heading="Go to">
                                {visiblePages.map((page) => (
                                    <CommandItem
                                        key={page.href}
                                        value={`${page.label} ${page.keywords}`}
                                        onSelect={() => go(page.href)}>
                                        <page.icon />
                                        <span className="min-w-0 flex-1 truncate">
                                            {page.label}
                                        </span>
                                        {page.gate && !gates[page.gate] && (
                                            <span className="text-text-tertiary ml-auto flex shrink-0 items-center gap-1 text-xs">
                                                <LockIcon className="size-3.5" />
                                                {GATE_PLAN_LABEL[page.gate]}
                                            </span>
                                        )}
                                    </CommandItem>
                                ))}
                            </CommandGroup>

                            <CommandSeparator />

                            <CommandGroup heading="Code review settings · Global">
                                {SETTINGS_TABS.map((tab) => (
                                    <CommandItem
                                        key={tab.href}
                                        value={`global ${tab.label} ${tab.keywords}`}
                                        onSelect={() =>
                                            go(settingsHref("global", tab.href))
                                        }>
                                        <GlobeIcon />
                                        <span className="min-w-0 flex-1 truncate">
                                            {tab.label}
                                        </span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>

                            {matchedRepositories.length > 0 && (
                                <CommandGroup heading="Repositories">
                                    {matchedRepositories.map(
                                        ({ key, repo, directory, value }) =>
                                            directory ? (
                                                <CommandItem
                                                    key={key}
                                                    value={value}
                                                    onSelect={() =>
                                                        go(
                                                            settingsHref(
                                                                repo.id,
                                                                "general",
                                                                directory.id,
                                                            ),
                                                        )
                                                    }>
                                                    <FolderTreeIcon />
                                                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                                                        <span className="shrink-0 truncate">
                                                            {repo.name}
                                                        </span>
                                                        <span className="text-text-tertiary min-w-0 truncate font-mono text-xs">
                                                            {directoryScopeLabel(
                                                                directory,
                                                            )}
                                                        </span>
                                                    </span>
                                                </CommandItem>
                                            ) : (
                                                <CommandItem
                                                    key={key}
                                                    value={value}
                                                    onSelect={() =>
                                                        go(
                                                            settingsHref(
                                                                repo.id,
                                                                "general",
                                                            ),
                                                        )
                                                    }>
                                                    <FolderIcon />
                                                    <span className="truncate">
                                                        {repo.name}
                                                    </span>
                                                    <span className="text-text-tertiary ml-auto text-xs">
                                                        settings
                                                    </span>
                                                </CommandItem>
                                            ),
                                    )}
                                </CommandGroup>
                            )}

                            {plugins && plugins.length > 0 && (
                                <CommandGroup heading="Plugins">
                                    {plugins.map((plugin) => (
                                        <CommandItem
                                            key={`${plugin.provider}-${plugin.id}`}
                                            value={`plugin ${plugin.name} ${plugin.appName} ${plugin.provider}`}
                                            onSelect={() =>
                                                go(
                                                    `/settings/plugins/${plugin.provider}/${plugin.id}`,
                                                )
                                            }>
                                            <PuzzleIcon />
                                            <span className="min-w-0 flex-1 truncate">
                                                {plugin.name}
                                            </span>
                                            <span className="text-text-tertiary ml-auto shrink-0 text-xs">
                                                {plugin.isConnected
                                                    ? "connected"
                                                    : "plugin"}
                                            </span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}

                            {matchedRules.length > 0 && (
                                <CommandGroup heading="Kody Rules">
                                    {matchedRules.map((rule) => (
                                        <CommandItem
                                            key={rule.uuid ?? rule.title}
                                            value={`rule ${rule.title}`}
                                            onSelect={() =>
                                                go(
                                                    rulePageHref(
                                                        {
                                                            ruleId: rule.uuid,
                                                            repositoryId:
                                                                rule.repositoryId,
                                                            directoryId:
                                                                rule.directoryId,
                                                            memories:
                                                                rule.type ===
                                                                "memory",
                                                        },
                                                        scopes,
                                                    ),
                                                )
                                            }>
                                            <ScrollTextIcon />
                                            <span className="truncate">
                                                {rule.title}
                                            </span>
                                            <span className="text-text-tertiary ml-auto shrink-0 text-xs">
                                                {scopeNames.get(
                                                    rule.repositoryId,
                                                ) ?? "global"}
                                            </span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}

                            {trimmed && !prNumber && (
                                <CommandGroup heading="Pull requests">
                                    <CommandItem
                                        value={`${trimmed} search pull requests`}
                                        onSelect={() =>
                                            go(
                                                `/pull-requests?by=title&q=${encodeURIComponent(trimmed)}`,
                                            )
                                        }>
                                        <SearchIcon />
                                        <span className="min-w-0 flex-1 truncate">
                                            Search pull requests for “{trimmed}”
                                        </span>
                                    </CommandItem>
                                </CommandGroup>
                            )}
                        </CommandList>
                    </Command>
                </DialogContent>
            </Dialog>
        </>
    );
};
