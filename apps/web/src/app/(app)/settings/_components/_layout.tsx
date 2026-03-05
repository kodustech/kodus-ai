"use client";

import { useEffect, useMemo, useState } from "react";
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
import { getMCPPlugins } from "@services/mcp-manager/fetch";
import { MCPServiceUnavailableError } from "@services/mcp-manager/utils";
import {
    useSuspenseGetDefaultCodeReviewParameter,
    useSuspenseGetFormattedCodeReviewParameter,
    useSuspenseGetParameterPlatformConfigs,
} from "@services/parameters/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQuery } from "@tanstack/react-query";
import { FEATURE_FLAGS } from "src/core/config/feature-flags";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

import { useCodeReviewRouteParams } from "../_hooks";
import { countConfigOverrides } from "../_utils/count-overrides";
import { FormattedConfigLevel } from "../code-review/_types";
import {
    AutomationCodeReviewConfigProvider,
    DefaultCodeReviewConfigProvider,
    PlatformConfigProvider,
    useFeatureFlags,
} from "./context";
import { PerRepository } from "./per-repository/repository";

const routes = [
    { label: "General", href: "general" },
    { label: "Review Categories", href: "review-categories" },
    { label: "Custom Prompts", href: "custom-prompts" },
    { label: "Suggestion Control", href: "suggestion-control" },
    { label: "PR Summary", href: "pr-summary" },
    { label: "Kody Rules", href: "kody-rules" },
    { label: "Custom Messages", href: "custom-messages" },
    {
        label: "Business Rules",
        href: "business-rules",
        featureFlag: "businessLogic",
    },
] satisfies Array<{
    label: string;
    href: string;
    featureFlag?: keyof typeof FEATURE_FLAGS;
}>;

export const SettingsLayout = ({ children }: React.PropsWithChildren) => {
    const pathname = usePathname();
    const { teamId } = useSelectedTeamId();
    const { configValue } = useSuspenseGetFormattedCodeReviewParameter(teamId);
    const defaultConfig = useSuspenseGetDefaultCodeReviewParameter();
    const platformConfig = useSuspenseGetParameterPlatformConfigs(teamId);
    const { repositoryId, pageName, directoryId } = useCodeReviewRouteParams();
    const featureFlags = useFeatureFlags();

    const globalOverrideCount = countConfigOverrides(
        configValue.configs,
        FormattedConfigLevel.GLOBAL,
    );

    const canReadGitSettings = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );
    const canReadBilling = usePermission(Action.Read, ResourceType.Billing);
    const canReadPlugins = usePermission(
        Action.Read,
        ResourceType.PluginSettings,
    );

    const { data: isMCPAvailable = true } = useQuery({
        queryKey: ["mcp-availability"],
        queryFn: async () => {
            try {
                await getMCPPlugins();
                return true;
            } catch (error) {
                if (error instanceof MCPServiceUnavailableError) return false;
                console.error("Failed to check MCP availability:", error);
                return true;
            }
        },
        enabled: canReadPlugins,
    });

    // Avoid hydration mismatch with Radix Collapsible IDs
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);

    const mainRoutes = useMemo(() => {
        const routes: Array<{
            label: string;
            href: string;
            badge?: React.ReactNode;
        }> = [];

        if (canReadGitSettings) {
            routes.push({
                label: "Git Settings",
                href: "/settings/git",
            });
        }

        if (canReadBilling) {
            routes.push({
                label: "Subscription",
                href: "/settings/subscription",
            });
        }

        if (canReadPlugins && isMCPAvailable) {
            routes.push({
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

        return routes;
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

    if (repositoryId && repositoryId !== "global") {
        const repository = safeArray(configValue?.repositories).find(
            (r) => r.id === repositoryId,
        );

        if (!repository) {
            redirect(`/settings/code-review/global/${pageName}`);
        }

        if (!repository?.isSelected) {
            const directory = safeArray(repository?.directories).find(
                (d) => d.id === directoryId,
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
                                {/* Render Collapsible only after mount to avoid hydration mismatch */}
                                {mounted ? (
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
                                                                    <Link
                                                                        className="w-full"
                                                                        href={`/settings/code-review/global/${href}`}>
                                                                        <Button
                                                                            decorative
                                                                            size="sm"
                                                                            variant="cancel"
                                                                            active={
                                                                                active
                                                                            }
                                                                            className="min-h-auto w-full justify-start px-0 py-2">
                                                                            {
                                                                                label
                                                                            }
                                                                        </Button>
                                                                    </Link>
                                                                </SidebarMenuSubItem>
                                                            );
                                                        },
                                                    )}
                                                </SidebarMenuSub>
                                            </SidebarMenuItem>
                                        </CollapsibleContent>
                                    </Collapsible>
                                ) : (
                                    <Button
                                        size="md"
                                        variant="helper"
                                        className="h-fit w-full justify-start py-2">
                                        Global
                                    </Button>
                                )}

                                <PerRepository
                                    routes={settingsRoutes}
                                    configValue={configValue}
                                    platformConfig={platformConfig}
                                />
                            </SidebarMenu>
                        </SidebarGroupContent>
                    </SidebarGroup>
                </SidebarContent>
            </Sidebar>

            <Page.WithSidebar>
                <DefaultCodeReviewConfigProvider config={defaultConfig}>
                    <AutomationCodeReviewConfigProvider config={configValue}>
                        <PlatformConfigProvider
                            config={platformConfig.configValue}>
                            {children}
                        </PlatformConfigProvider>
                    </AutomationCodeReviewConfigProvider>
                </DefaultCodeReviewConfigProvider>
            </Page.WithSidebar>
        </div>
    );
};
