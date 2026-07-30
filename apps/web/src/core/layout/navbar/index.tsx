"use client";

import { Suspense, useMemo } from "react";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import {
    NavigationMenu,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
} from "@components/ui/navigation-menu";
import { Spinner } from "@components/ui/spinner";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import {
    GaugeIcon,
    GitPullRequestIcon,
    InfoIcon,
    LibraryBig,
    LockIcon,
    SlidersHorizontalIcon,
    TerminalIcon,
} from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { UserNav } from "src/core/layout/navbar/_components/user-nav";
import { cn } from "src/core/utils/components";
import { isCockpitTierAllowed } from "src/features/ee/cockpit/_helpers/tier-policy";
import { SubscriptionBadge } from "src/features/ee/subscription/_components/subscription-badge";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import { GithubStars } from "./_components/github-stars";
import { IssuesCount } from "./_components/issues-count";
import { NotificationBell } from "./_components/notification-bell";
import { VERSION_QUERY } from "./_components/version-info";

export const NavMenu = () => {
    const pathname = usePathname();
    const subscription = useSubscriptionContext();
    const queryClient = useQueryClient();
    queryClient.prefetchQuery(VERSION_QUERY);

    const canReadIssues = usePermission(Action.Read, ResourceType.Issues);
    const canReadPullRequests = usePermission(
        Action.Read,
        ResourceType.PullRequests,
    );
    const canReadCliReviews = usePermission(
        Action.Read,
        ResourceType.CliReview,
    );
    const canReadCodeReviewSettings = usePermission(
        Action.Read,
        ResourceType.CodeReviewSettings,
    );
    const canReadBilling = usePermission(Action.Read, ResourceType.Billing);
    const canReadGitSettings = usePermission(
        Action.Read,
        ResourceType.GitSettings,
    );
    const canReadPlugins = usePermission(
        Action.Read,
        ResourceType.PluginSettings,
    );

    const items = useMemo(() => {
        const items: Array<{
            label: string;
            icon: React.JSX.Element;
            href: string;
            visible: boolean;
            badge?: React.JSX.Element;
            matcher?: (pathname: string) => boolean;
        }> = [
            {
                label: "Cockpit",
                href: "/cockpit",
                // Always visible: below the allowed tier the route renders a
                // blurred preview with an upgrade CTA (apps/web/.../cockpit/
                // layout.tsx), so the nav item shows a lock instead of hiding.
                visible: true,
                icon: <GaugeIcon className="size-6" />,
                badge: isCockpitTierAllowed(subscription.license) ? undefined : (
                    <LockIcon className="size-3.5" />
                ),
            },

            {
                label: "Code Review Settings",
                icon: <SlidersHorizontalIcon className="size-5" />,
                href: "/settings",
                visible:
                    canReadCodeReviewSettings ||
                    canReadGitSettings ||
                    canReadBilling ||
                    canReadPlugins,
            },

            {
                label: "Library",
                icon: <LibraryBig className="size-5" />,
                href: "/library/kody-rules",
                visible: canReadCodeReviewSettings,
            },
        ];

        if (canReadIssues) {
            items.push({
                label: "Issues",
                href: "/issues",
                visible: canReadIssues,
                icon: <InfoIcon className="size-5" />,
                badge: (
                    <div className="h-5 min-h-auto min-w-8">
                        <Suspense
                            fallback={
                                <div className="flex size-full items-center justify-center">
                                    <Spinner className="size-4" />
                                </div>
                            }>
                            <IssuesCount />
                        </Suspense>
                    </div>
                ),
            });
        }

        if (canReadPullRequests) {
            items.push({
                label: "Pull Requests",
                href: "/pull-requests",
                visible: canReadPullRequests,
                icon: <GitPullRequestIcon className="size-5" />,
            });
        }

        if (canReadCliReviews) {
            items.push({
                label: "CLI Reviews",
                href: "/cli-reviews",
                visible: canReadCliReviews,
                icon: <TerminalIcon className="size-5" />,
            });
        }

        return items;
    }, [
        subscription.license.valid,
        subscription.license.subscriptionStatus,
        "planType" in subscription.license
            ? subscription.license.planType
            : undefined,
        canReadCodeReviewSettings,
        canReadGitSettings,
        canReadBilling,
        canReadPlugins,
        canReadIssues,
        canReadPullRequests,
        canReadCliReviews,
    ]);

    const isActive = (
        route: string,
        matcher?: (pathname: string) => boolean,
    ) => {
        if (matcher) return matcher(pathname);
        return pathname.startsWith(route);
    };

    return (
        <div className="border-primary-dark bg-card-lv1 z-50 flex h-16 shrink-0 gap-4 border-b-2 px-6">
            <NextLink href="/" className="flex items-center">
                <SvgKodus className="h-8 max-w-max" />
            </NextLink>

            {/* min-w-0 lets this flex child shrink below the nav's intrinsic
                (whitespace-nowrap) width instead of forcing the whole h-16 bar
                past the viewport — which, under the shell's w-screen +
                overflow-hidden, clipped every page's content on the right at
                widths below ~1230px. overflow-x-auto keeps the links reachable
                by scrolling within the bar. */}
            <div className="-mb-1 h-full min-w-0 flex-1 overflow-x-auto">
                <NavigationMenu className="h-full *:h-full">
                    <NavigationMenuList className="h-full gap-0">
                        {items.map(
                            ({
                                label,
                                icon,
                                href,
                                visible,
                                badge,
                                matcher,
                            }) => {
                                if (!visible) return null;

                                return (
                                    <NavigationMenuItem
                                        key={label}
                                        className="h-full">
                                        <NavigationMenuLink
                                            href={href}
                                            active={isActive(href, matcher)}
                                            className={cn(
                                                "text-text-tertiary relative flex h-full flex-row items-center gap-2 border-b-2 border-transparent px-3 text-xs whitespace-nowrap transition",
                                                "hover:text-white focus-visible:text-white",
                                                "data-active:font-semibold data-active:text-white",
                                                "data-active:border-primary-light",
                                            )}>
                                            {icon}
                                            {label}
                                            {badge}
                                        </NavigationMenuLink>
                                    </NavigationMenuItem>
                                );
                            },
                        )}
                    </NavigationMenuList>
                </NavigationMenu>
            </div>

            <div className="flex items-center gap-4">
                <ErrorBoundary fallback={null}>
                    <GithubStars />
                </ErrorBoundary>

                <div className="flex items-center gap-2">
                    <SubscriptionBadge />
                    <NotificationBell />
                </div>

                <UserNav />
            </div>
        </div>
    );
};
