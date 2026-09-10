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
import type { KodyRule } from "@services/kodyRules/types";
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { PARAMETERS_PATHS } from "@services/parameters";
import { useQuery } from "@tanstack/react-query";
import {
    ActivityIcon,
    BellIcon,
    BookOpenIcon,
    Building2Icon,
    ChartColumnIcon,
    CreditCardIcon,
    FolderIcon,
    FolderTreeIcon,
    GaugeIcon,
    GitBranchIcon,
    GitPullRequestIcon,
    GlobeIcon,
    KeyRoundIcon,
    LockIcon,
    MessageSquareTextIcon,
    PlugIcon,
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
import type { FormattedGlobalCodeReviewConfig } from "src/app/(app)/settings/code-review/_types";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
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
}> = [
    {
        label: "Pull requests",
        href: "/pull-requests",
        icon: GitPullRequestIcon,
        keywords: "reviews prs",
    },
    {
        label: "CLI reviews",
        href: "/cli-reviews",
        icon: TerminalIcon,
        keywords: "reviews cli terminal",
    },
    {
        label: "Cockpit",
        href: "/cockpit",
        icon: GaugeIcon,
        keywords: "metrics analytics dashboard productivity",
        gate: "cockpit",
    },
    {
        label: "Issues",
        href: "/issues",
        icon: TriangleAlertIcon,
        keywords: "cockpit open resolved",
        gate: "cockpit",
    },
    {
        label: "Plugins",
        href: "/settings/plugins",
        icon: PuzzleIcon,
        keywords: "mcp integrations tools",
    },
    {
        label: "Integrations",
        href: "/settings/integrations",
        icon: PlugIcon,
        keywords: "github gitlab bitbucket azure jira",
    },
    {
        label: "Git settings",
        href: "/settings/git",
        icon: GitBranchIcon,
        keywords: "repositories provider connection",
    },
    {
        label: "Rules library",
        href: "/library/kody-rules",
        icon: BookOpenIcon,
        keywords: "marketplace kody rules packs",
    },
    {
        label: "Models",
        href: "/byok",
        icon: SparklesIcon,
        keywords: "byok bring your own key api key model provider llm routing",
    },
    {
        label: "Subscription",
        href: "/settings/subscription",
        icon: CreditCardIcon,
        keywords: "billing plan licenses seats",
    },
    {
        label: "Token usage",
        href: "/token-usage",
        icon: ChartColumnIcon,
        keywords: "cost spend tokens",
    },
    {
        label: "Activity logs",
        href: "/user-logs",
        icon: ActivityIcon,
        keywords: "audit history",
        gate: "activityLogs",
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
    {
        label: "Review filters",
        href: "suggestion-control",
        icon: ScanSearchIcon,
        keywords: "severity suggestion control limit",
    },
    {
        label: "Review categories",
        href: "review-categories",
        icon: ScanSearchIcon,
        keywords: "bug performance security",
    },
];

const settingsHref = (
    repositoryId: string,
    page: string,
    directoryId?: string,
) => {
    const base = `/settings/code-review/${repositoryId}/${page}`;
    return directoryId ? `${base}?directoryId=${directoryId}` : base;
};

// Same label the settings scope switcher uses: the first linked folder's
// path, or the directory name when it has none.
const directoryLabel = (directory: {
    name: string;
    folders?: Array<{ path: string }>;
}) => {
    const folders = directory.folders ?? [];
    const path = folders[0]?.path ?? directory.name;
    return folders.length > 1 ? `${path} +${folders.length - 1}` : path;
};

const ruleHref = (rule: KodyRule) => {
    const repo = rule.repositoryId || "global";
    const params = new URLSearchParams();
    if (rule.uuid) params.set("rule", rule.uuid);
    if (rule.type === "memory") params.set("tab", "memories");
    if (rule.directoryId) params.set("directoryId", rule.directoryId);
    return `/settings/code-review/${repo}/kody-rules?${params.toString()}`;
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

export const CommandPalette = () => {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
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

    const { data: rules } = useFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        undefined,
        open,
        { staleTime: 60_000 },
    );
    const { data: config } = useFetch<{
        configValue: FormattedGlobalCodeReviewConfig;
    }>(
        PARAMETERS_PATHS.GET_CODE_REVIEW_PARAMETER,
        { params: { teamId } },
        open && Boolean(teamId),
        { staleTime: 60_000 },
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
            (config?.configValue?.repositories ?? []).filter(
                (repo) =>
                    repo.isSelected || (repo.directories?.length ?? 0) > 0,
            ),
        [config],
    );

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
                                {PAGES.map((page) => (
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

                            {repositories.length > 0 && (
                                <CommandGroup heading="Repositories">
                                    {repositories.map((repo) => (
                                        <div key={repo.id}>
                                            <CommandItem
                                                value={`repo ${repo.name}`}
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
                                            {(repo.directories ?? []).map(
                                                (directory) => (
                                                    <CommandItem
                                                        key={directory.id}
                                                        value={`directory ${repo.name} ${directoryLabel(directory)}`}
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
                                                                {directoryLabel(
                                                                    directory,
                                                                )}
                                                            </span>
                                                        </span>
                                                    </CommandItem>
                                                ),
                                            )}
                                        </div>
                                    ))}
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

                            {rules && rules.length > 0 && (
                                <CommandGroup heading="Kody Rules">
                                    {rules.map((rule) => (
                                        <CommandItem
                                            key={rule.uuid ?? rule.title}
                                            value={`rule ${rule.title}`}
                                            onSelect={() => go(ruleHref(rule))}>
                                            <ScrollTextIcon />
                                            <span className="truncate">
                                                {rule.title}
                                            </span>
                                            <span className="text-text-tertiary ml-auto shrink-0 text-xs">
                                                {rule.repositoryId &&
                                                rule.repositoryId !== "global"
                                                    ? "repository"
                                                    : "global"}
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
