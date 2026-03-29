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
import { Link } from "@components/ui/link";
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
import { useMCPAvailability } from "@services/mcp-manager/hooks";
import {
    useCodeReviewSettingsShell,
    useSuspenseGetDefaultCodeReviewParameter,
    useSuspenseGetParameterPlatformConfigs,
} from "@services/parameters/hooks";
import {
    ParametersConfigKey,
    type PlatformConfigValue,
} from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { CustomMessageConfig } from "@services/pull-request-messages/types";
import { FEATURE_FLAGS } from "src/core/config/feature-flags";
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
import {
    AutomationCodeReviewConfigProvider,
    DefaultCodeReviewConfigProvider,
    PlatformConfigProvider,
    ScopedCodeReviewConfigProvider,
    useFeatureFlags,
} from "./context";
import { PerRepository } from "./per-repository/repository";
import {
    RouteButtonWithOverrideCount,
    useCustomMessagesOverrideCount,
} from "./route-button-with-override-count";

const routes = [
    { label: "General", href: "general" },
    { label: "Review Categories", href: "review-categories" },
    { label: "Custom Prompts", href: "custom-prompts" },
    { label: "Suggestion Control", href: "suggestion-control" },
    { label: "PR Summary", href: "pr-summary" },
    { label: "Kody Rules", href: "kody-rules" },
    { label: "Custom Messages", href: "custom-messages" },
] satisfies Array<{
    label: string;
    href: string;
    featureFlag?: keyof typeof FEATURE_FLAGS;
}>;

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
    initialConfigValue: FormattedGlobalCodeReviewConfig;
    initialDefaultConfig: InitialDefaultConfig;
    initialPlatformConfig: InitialPlatformConfig;
}>;

export const SettingsLayout = ({
    children,
    initialTeamId,
    initialConfigValue,
    initialDefaultConfig,
    initialPlatformConfig,
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
    const canReadPlugins = usePermission(
        Action.Read,
        ResourceType.PluginSettings,
    );
    const { data: isMCPAvailable = true } = useMCPAvailability(canReadPlugins);

    const initialShellQueryData = useMemo<{
        uuid: string;
        configKey: ParametersConfigKey.CODE_REVIEW_CONFIG;
        configValue: FormattedGlobalCodeReviewConfig;
    }>(
        () => ({
            uuid: "",
            configKey: ParametersConfigKey.CODE_REVIEW_CONFIG,
            configValue: initialConfigValue,
        }),
        [initialConfigValue],
    );

    const { data: liveShellQuery } = useCodeReviewSettingsShell(
        effectiveTeamId,
        {
            initialData:
                effectiveTeamId === initialTeamId
                    ? initialShellQueryData
                    : undefined,
        },
    );

    return (
        <SettingsLayoutShell
            teamId={effectiveTeamId}
            configValue={liveShellQuery?.configValue ?? initialConfigValue}
            defaultConfig={defaultConfig ?? initialDefaultConfig}
            platformConfig={platformConfig ?? initialPlatformConfig}
            isMCPAvailable={isMCPAvailable}>
            {children}
        </SettingsLayoutShell>
    );
};

function SettingsLayoutShell({
    children,
    teamId,
    configValue,
    defaultConfig,
    platformConfig,
    isMCPAvailable,
}: React.PropsWithChildren<{
    teamId: string;
    configValue: FormattedGlobalCodeReviewConfig | undefined;
    defaultConfig: InitialDefaultConfig;
    platformConfig: InitialPlatformConfig;
    isMCPAvailable: boolean;
}>) {
    const pathname = usePathname();
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();
    const featureFlags = useFeatureFlags();
    const globalConfigOverrideCount = configValue
        ? countConfigOverridesForRoutes(
              configValue.configs,
              routes.map((r) => r.href),
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

    const canReadGitSettings = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );
    const canReadBilling = usePermission(Action.Read, ResourceType.Billing);
    const canReadPlugins = usePermission(
        Action.Read,
        ResourceType.PluginSettings,
    );

    const mainRoutes = useMemo(() => {
        const nextRoutes: Array<{
            label: string;
            href: string;
            badge?: React.ReactNode;
        }> = [];

        if (canReadGitSettings) {
            nextRoutes.push({
                label: "Git Settings",
                href: "/settings/git",
            });
        }

        if (canReadBilling) {
            nextRoutes.push({
                label: "Subscription",
                href: "/settings/subscription",
            });
        }

        if (canReadPlugins && isMCPAvailable) {
            nextRoutes.push({
                label: "Plugins",
                href: "/settings/plugins",
                badge: (
                    <Badge
                        variant="secondary"
                        className="pointer-events-none -my-1 h-6 min-h-auto px-2.5">
                        Beta
                    </Badge>
                ),
            });
        }

        return nextRoutes;
    }, [canReadGitSettings, canReadBilling, canReadPlugins, isMCPAvailable]);

    const settingsRoutes = useMemo(
        () =>
            routes.filter(
                (route) =>
                    !route.featureFlag ||
                    featureFlags?.[route.featureFlag] === true,
            ),
        [featureFlags],
    );

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

    return (
        <div className="flex flex-1 flex-row overflow-hidden">
            <Sidebar className="bg-card-lv1 px-0 py-0">
                <SidebarContent className="gap-4 px-6 py-6">
                    <SidebarGroup>
                        <SidebarGroupContent>
                            <SidebarMenu>
                                {mainRoutes.map((route) => (
                                    <SidebarMenuItem key={route.href}>
                                        <Link
                                            href={route.href}
                                            className="w-full">
                                            <Button
                                                size="md"
                                                decorative
                                                className="w-full justify-start"
                                                active={pathname === route.href}
                                                rightIcon={route.badge}
                                                variant={
                                                    pathname.startsWith(
                                                        route.href,
                                                    )
                                                        ? "helper"
                                                        : "cancel"
                                                }>
                                                {route.label}
                                            </Button>
                                        </Link>
                                    </SidebarMenuItem>
                                ))}
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>

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
                                                    globalOverrideCount > 0 && (
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
                                                    {settingsRoutes.map(
                                                        ({ label, href }) => {
                                                            const active =
                                                                repositoryId ===
                                                                    "global" &&
                                                                pageName ===
                                                                    href;

                                                            return (
                                                                <SidebarMenuSubItem
                                                                    key={label}>
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
                                        settingsRoutes={settingsRoutes}
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

            <Page.WithSidebar>
                {configValue ? (
                    <DefaultCodeReviewConfigProvider config={defaultConfig}>
                        <AutomationCodeReviewConfigProvider
                            config={configValue}>
                            <ScopedCodeReviewConfigProvider
                                config={scopedConfig}>
                                <PlatformConfigProvider
                                    config={platformConfig.configValue}>
                                    {children}
                                </PlatformConfigProvider>
                            </ScopedCodeReviewConfigProvider>
                        </AutomationCodeReviewConfigProvider>
                    </DefaultCodeReviewConfigProvider>
                ) : (
                    <SettingsShellContentSkeleton />
                )}
            </Page.WithSidebar>
        </div>
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

function SettingsShellContentSkeleton() {
    return (
        <Page.Root>
            <Page.Header>
                <Skeleton className="h-6 w-48" />
            </Page.Header>

            <Page.Content>
                <Skeleton className="h-12 w-64" />
                <Skeleton className="h-56 w-full rounded-xl" />
                <Skeleton className="h-56 w-full rounded-xl" />
            </Page.Content>
        </Page.Root>
    );
}
