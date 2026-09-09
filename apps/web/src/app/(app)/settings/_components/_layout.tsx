"use client";

import { useMemo } from "react";
import { redirect, usePathname } from "next/navigation";
import { Badge } from "@components/ui/badge";
import { Button } from "@components/ui/button";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import { Page } from "@components/ui/page";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuSub,
    SidebarMenuSubItem,
} from "@components/ui/sidebar";
import { Skeleton } from "@components/ui/skeleton";
import {
    useCodeReviewSettingsShell,
    useSuspenseGetDefaultCodeReviewParameter,
    useSuspenseGetParameterPlatformConfigs,
} from "@services/parameters/hooks";
import {
    ParametersConfigKey,
    type PlatformConfigValue,
} from "@services/parameters/types";
import type { CustomMessageConfig } from "@services/pull-request-messages/types";
import { SettingsPageSkeleton } from "src/core/components/system/page-skeletons";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../_hooks";
import { countConfigOverridesForRoutes } from "../_utils/count-overrides";
import {
    FormattedConfigLevel,
    type CodeReviewGlobalConfig,
    type FormattedGlobalCodeReviewConfig,
} from "../code-review/_types";
import { resolveCodeReviewConfigForScope } from "./code-review-config-scope";
import { CodeReviewShellHeader } from "./code-review-shell-header";
import {
    AutomationCodeReviewConfigProvider,
    CodeReviewConfigFetchStateProvider,
    CodeReviewModelDataProvider,
    DefaultCodeReviewConfigProvider,
    InitialParametersProvider,
    PlatformConfigProvider,
    ScopedCodeReviewConfigProvider,
    useFeatureFlags,
    type CodeReviewModelData,
} from "./context";
import { PerRepository } from "./per-repository/repository";
import {
    RouteButtonWithOverrideCount,
    useCustomMessagesOverrideCount,
} from "./route-button-with-override-count";
import { SettingsShellHeaderSkeleton } from "./settings-shell-skeleton";
import {
    SettingsShellModeProvider,
    type SettingsShellMode,
} from "./shell-mode-context";

// `shortLabel` is what the tabs shell shows: eight tabs plus the scope must
// fit one row without horizontal scroll, and inside Settings the "Review"
// and "Custom" prefixes carry no information.
const routes = [
    { label: "General", href: "general" },
    {
        label: "Review Categories",
        shortLabel: "Categories",
        href: "review-categories",
    },
    {
        label: "Review Filters",
        shortLabel: "Filters",
        href: "suggestion-control",
    },
    { label: "Custom Prompts", shortLabel: "Prompts", href: "custom-prompts" },
    { label: "PR Summary", shortLabel: "Summary", href: "pr-summary" },
    { label: "Kody Rules", href: "kody-rules" },
    {
        label: "Custom Messages",
        shortLabel: "Messages",
        href: "custom-messages",
    },
    // Cross-repo context (#1576): relationships are directional and
    // repo-scoped by design (a global default would link EVERY repo to the
    // same siblings), so the item only renders in repository submenus.
    {
        label: "Linked Repositories",
        shortLabel: "Linked repos",
        href: "linked-repositories",
        repoOnly: true,
    },
] satisfies Array<{
    label: string;
    shortLabel?: string;
    href: string;
    repoOnly?: boolean;
}>;

// Tabs shell (alpha): one tab per question the user brings. Categories,
// filters and the per-category prompts collapse into "What to review"; the
// rail keeps the original pages so nothing moves for everyone else.
const tabsRoutes = [
    { label: "General", href: "general" },
    { label: "What to review", href: "review-scope" },
    { label: "Kody Rules", href: "kody-rules" },
    { label: "What Kody writes", href: "output" },
    {
        label: "Linked Repositories",
        shortLabel: "Linked repos",
        href: "linked-repositories",
        repoOnly: true,
    },
] satisfies typeof routes;

// Global scope never shows repo-only routes (see `repoOnly` on `routes`).
const globalSettingsRoutes = routes.filter(
    (r) => !("repoOnly" in r && r.repoOnly),
);

type InitialPlatformConfig = {
    uuid: string;
    configKey: ParametersConfigKey.PLATFORM_CONFIGS;
    configValue: PlatformConfigValue;
};

type InitialDefaultConfig = CodeReviewGlobalConfig & {
    customMessages: CustomMessageConfig;
};

type SettingsLayoutProps = React.PropsWithChildren<{
    initialTeamId: string;
    // Undefined when the server-side fetch was skipped, timed out or failed —
    // the matching client hook then fetches it instead of the page blanking.
    initialConfigValue: FormattedGlobalCodeReviewConfig | undefined;
    initialDefaultConfig: InitialDefaultConfig | undefined;
    initialPlatformConfig: InitialPlatformConfig | undefined;
    initialParameters: Partial<
        Record<
            string,
            { uuid: string; configKey: string; configValue: string } | null
        >
    >;
    initialModelData: CodeReviewModelData;
}>;

export const SettingsLayout = ({
    children,
    initialTeamId,
    initialConfigValue,
    initialDefaultConfig,
    initialPlatformConfig,
    initialParameters,
    initialModelData,
}: SettingsLayoutProps) => {
    const { teamId } = useSelectedTeamId();
    const effectiveTeamId = teamId ?? initialTeamId;
    const defaultConfig = useSuspenseGetDefaultCodeReviewParameter({
        initialData: initialDefaultConfig,
    });
    const platformConfig = useSuspenseGetParameterPlatformConfigs(
        effectiveTeamId,
        {
            initialData:
                effectiveTeamId === initialTeamId
                    ? initialPlatformConfig
                    : undefined,
        },
    );

    const initialShellQueryData = useMemo<
        | {
              uuid: string;
              configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
              configValue: FormattedGlobalCodeReviewConfig;
          }
        | undefined
    >(
        () =>
            initialConfigValue
                ? {
                      uuid: "",
                      configKey: ParametersConfigKey.CODE_REVIEW_CONFIG,
                      configValue: initialConfigValue,
                  }
                : undefined,
        [initialConfigValue],
    );

    const {
        data: liveShellQuery,
        isFetching: isShellFetching,
        isError: isShellError,
    } = useCodeReviewSettingsShell(effectiveTeamId, {
        initialData:
            effectiveTeamId === initialTeamId
                ? initialShellQueryData
                : undefined,
    });

    return (
        <CodeReviewModelDataProvider value={initialModelData}>
            <CodeReviewConfigFetchStateProvider
                value={{
                    isFetching: isShellFetching,
                    isError: isShellError,
                }}>
                <InitialParametersProvider
                    value={{ initialTeamId, parameters: initialParameters }}>
                    <SettingsLayoutShell
                        teamId={effectiveTeamId}
                        configValue={
                            liveShellQuery?.configValue ?? initialConfigValue
                        }
                        defaultConfig={defaultConfig ?? initialDefaultConfig}
                        platformConfig={
                            platformConfig ?? initialPlatformConfig
                        }>
                        {children}
                    </SettingsLayoutShell>
                </InitialParametersProvider>
            </CodeReviewConfigFetchStateProvider>
        </CodeReviewModelDataProvider>
    );
};

function SettingsLayoutShell({
    children,
    teamId,
    configValue,
    defaultConfig,
    platformConfig,
}: React.PropsWithChildren<{
    teamId: string;
    configValue: FormattedGlobalCodeReviewConfig | undefined;
    defaultConfig: InitialDefaultConfig;
    platformConfig: InitialPlatformConfig;
}>) {
    const pathname = usePathname();
    // Alpha flag `settings-tabs-shell`: scope switcher + page tabs in a
    // header band instead of the side rail. Everyone else keeps the rail.
    const shellMode: SettingsShellMode = useFeatureFlags().settingsTabsShell
        ? "tabs"
        : "rail";
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();
    const globalConfigOverrideCount = configValue
        ? countConfigOverridesForRoutes(
              configValue.configs,
              globalSettingsRoutes.map((r) => r.href),
              FormattedConfigLevel.GLOBAL,
          )
        : 0;
    const globalCustomMessagesOverrideCount = useCustomMessagesOverrideCount({
        scopeRepositoryId: "global",
        level: FormattedConfigLevel.GLOBAL,
        enabled: Boolean(configValue),
    });
    const globalOverrideCount =
        globalConfigOverrideCount + globalCustomMessagesOverrideCount;

    const settingsRoutes = routes;

    const isShellLoading = !configValue;

    const scopedConfig = useMemo(
        () =>
            configValue
                ? resolveCodeReviewConfigForScope(
                      configValue,
                      repositoryId,
                      directoryId,
                  )
                : undefined,
        [configValue, directoryId, repositoryId],
    );

    if (!isShellLoading && repositoryId && repositoryId !== "global") {
        const repository = safeArray(configValue?.repositories).find(
            (repositoryItem) => repositoryItem.id === repositoryId,
        );

        if (!repository) {
            redirect(`/settings/code-review/global/${pageName}`);
        }

        if (!repository?.isSelected) {
            const directory = safeArray(repository?.directories).find(
                (directoryItem) => directoryItem.id === directoryId,
            );

            if (!directory) {
                redirect(`/settings/code-review/global/${pageName}`);
            }
        }
    }

    const content = configValue ? (
        <DefaultCodeReviewConfigProvider config={defaultConfig}>
            <AutomationCodeReviewConfigProvider config={configValue}>
                <ScopedCodeReviewConfigProvider config={scopedConfig}>
                    <PlatformConfigProvider config={platformConfig.configValue}>
                        {shellMode === "tabs" &&
                            pathname.startsWith("/settings/code-review") && (
                                <CodeReviewShellHeader
                                    configValue={configValue}
                                    platformConfigValue={
                                        platformConfig.configValue
                                    }
                                    routes={tabsRoutes}
                                    globalOverrideCount={globalOverrideCount}
                                />
                            )}
                        {children}
                    </PlatformConfigProvider>
                </ScopedCodeReviewConfigProvider>
            </AutomationCodeReviewConfigProvider>
        </DefaultCodeReviewConfigProvider>
    ) : (
        <>
            {shellMode === "tabs" &&
                pathname.startsWith("/settings/code-review") && (
                    <SettingsShellHeaderSkeleton />
                )}
            <SettingsPageSkeleton />
        </>
    );

    if (shellMode === "tabs") {
        // No rail: scope + page nav live in a header band and the page owns
        // the full width below it.
        return (
            <SettingsShellModeProvider value={shellMode}>
                <div className="flex flex-1 flex-col overflow-hidden">
                    {content}
                </div>
            </SettingsShellModeProvider>
        );
    }

    return (
        <SettingsShellModeProvider value={shellMode}>
            <div className="flex flex-1 flex-row overflow-hidden">
                {/* 256px rail (was 320) with tighter padding: Git Settings,
                    Subscription and Plugins moved to the avatar menu / navbar,
                    so the rail is only the scope tree now. */}
                <Sidebar className="bg-card-lv1 w-64 px-0 py-0">
                    <SidebarContent className="gap-4 px-4 py-5">
                        <SidebarGroup>
                            <SidebarGroupContent>
                                <SidebarMenu className="gap-6">
                                    {!isShellLoading ? (
                                        <Collapsible
                                            defaultOpen={
                                                repositoryId === "global" ||
                                                !repositoryId
                                            }>
                                            <CollapsibleTrigger asChild>
                                                <Button
                                                    size="md"
                                                    variant="helper"
                                                    className="h-fit w-full justify-start py-2"
                                                    leftIcon={
                                                        <CollapsibleIndicator className="-ml-1 group-data-[state=closed]/collapsible:rotate-[-90deg] group-data-[state=open]/collapsible:rotate-0" />
                                                    }
                                                    rightIcon={
                                                        globalOverrideCount >
                                                            0 && (
                                                            <Badge
                                                                variant="primary-dark"
                                                                className="h-5 min-w-5 rounded-full px-1.5 text-[10px] font-medium">
                                                                {
                                                                    globalOverrideCount
                                                                }
                                                            </Badge>
                                                        )
                                                    }>
                                                    Global
                                                </Button>
                                            </CollapsibleTrigger>

                                            <CollapsibleContent>
                                                <SidebarMenuItem>
                                                    <SidebarMenuSub>
                                                        {globalSettingsRoutes.map(
                                                            ({
                                                                label,
                                                                href,
                                                            }) => {
                                                                const active =
                                                                    repositoryId ===
                                                                        "global" &&
                                                                    pageName ===
                                                                        href;

                                                                return (
                                                                    <SidebarMenuSubItem
                                                                        key={
                                                                            label
                                                                        }>
                                                                        <RouteButtonWithOverrideCount
                                                                            label={
                                                                                label
                                                                            }
                                                                            href={
                                                                                href
                                                                            }
                                                                            to={`/settings/code-review/global/${href}`}
                                                                            active={
                                                                                active
                                                                            }
                                                                            level={
                                                                                FormattedConfigLevel.GLOBAL
                                                                            }
                                                                            config={
                                                                                configValue.configs
                                                                            }
                                                                            customMessagesOverrideCount={
                                                                                globalCustomMessagesOverrideCount
                                                                            }
                                                                        />
                                                                    </SidebarMenuSubItem>
                                                                );
                                                            },
                                                        )}
                                                    </SidebarMenuSub>
                                                </SidebarMenuItem>
                                            </CollapsibleContent>
                                        </Collapsible>
                                    ) : (
                                        <SettingsGlobalSidebarSkeleton
                                            settingsRoutes={
                                                globalSettingsRoutes
                                            }
                                        />
                                    )}

                                    {configValue ? (
                                        <PerRepository
                                            routes={settingsRoutes}
                                            configValue={configValue}
                                            platformConfig={platformConfig}
                                        />
                                    ) : (
                                        <SettingsPerRepositorySkeleton />
                                    )}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    </SidebarContent>
                </Sidebar>

                <Page.WithSidebar>{content}</Page.WithSidebar>
            </div>
        </SettingsShellModeProvider>
    );
}

function SettingsGlobalSidebarSkeleton({
    settingsRoutes,
}: {
    settingsRoutes: Array<{ label: string; href: string }>;
}) {
    return (
        <div className="flex flex-col gap-2">
            <Button
                size="md"
                variant="helper"
                disabled
                className="h-fit w-full justify-start py-2">
                Global
            </Button>

            <div className="space-y-2 pl-6">
                {settingsRoutes.slice(0, 4).map((route) => (
                    <Skeleton
                        key={route.href}
                        className="h-8 w-full rounded-md"
                    />
                ))}
            </div>
        </div>
    );
}

function SettingsPerRepositorySkeleton() {
    return (
        <div className="pl-2">
            <div className="mb-4 flex flex-col gap-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
            </div>

            <div className="space-y-2">
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-10 w-full rounded-md" />
            </div>
        </div>
    );
}
