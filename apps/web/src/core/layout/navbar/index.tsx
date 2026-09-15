"use client";

import { useMemo } from "react";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import {
    NavigationMenu,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
} from "@components/ui/navigation-menu";
import { useMCPAvailability } from "@services/mcp-manager/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { formatUsd } from "@services/usage/format";
import { useQueryClient } from "@tanstack/react-query";
import {
    BlocksIcon,
    GaugeIcon,
    GitPullRequestIcon,
    LockIcon,
    SlidersHorizontalIcon,
    SparklesIcon,
} from "lucide-react";
import { ErrorBoundary } from "react-error-boundary";
import { UserNav } from "src/core/layout/navbar/_components/user-nav";
import { cn } from "src/core/utils/components";
import { useKodusCreditBalance } from "src/features/ee/byok/_hooks/use-kodus-credit-balance";
import { isCockpitTierAllowed } from "src/features/ee/cockpit/_helpers/tier-policy";
import { SubscriptionBadge } from "src/features/ee/subscription/_components/subscription-badge";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";

import { CommandPalette } from "./_components/command-palette";
import { GithubStars } from "./_components/github-stars";
import { NotificationBell } from "./_components/notification-bell";
import { VERSION_QUERY } from "./_components/version-info";

export const NavMenu = () => {
    const pathname = usePathname();
    const subscription = useSubscriptionContext();
    const queryClient = useQueryClient();
    queryClient.prefetchQuery(VERSION_QUERY);

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
    const canEditOrg = usePermission(
        Action.Update,
        ResourceType.OrganizationSettings,
    );
    const credits = useKodusCreditBalance();
    const { data: isMCPAvailable = true } = useMCPAvailability(canReadPlugins);

    // Four destinations. Reviews folds Pull Requests + CLI Reviews (tabs on
    // the page); Issues lives inside the Cockpit; Library is reached from
    // Kody Rules; Git Settings + Subscription sit in the avatar menu.
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
                label: "Reviews",
                href: "/pull-requests",
                visible: canReadPullRequests || canReadCliReviews,
                icon: <GitPullRequestIcon className="size-5" />,
                matcher: (path) =>
                    path.startsWith("/pull-requests") ||
                    path.startsWith("/cli-reviews"),
            },
            {
                label: "Cockpit",
                href: "/cockpit",
                // Always visible: below the allowed tier the route renders a
                // blurred preview with an upgrade CTA (apps/web/.../cockpit/
                // layout.tsx), so the nav item shows a lock instead of hiding.
                visible: true,
                icon: <GaugeIcon className="size-6" />,
                badge: isCockpitTierAllowed(
                    subscription.license,
                ) ? undefined : (
                    <LockIcon className="size-3.5" />
                ),
            },

            {
                // Which model reviews the code and whose key pays for it —
                // a first-order product decision, so it sits in the main nav
                // instead of being reachable only from the avatar menu. The
                // label matches the page's own title.
                label: "AI providers",
                icon: <SparklesIcon className="size-5" />,
                href: credits.usesKodusProvider ? "/byok#kodus" : "/byok",
                visible: canEditOrg,
                matcher: (path) => path.startsWith("/byok"),
                // Orgs on the Kodus provider carry their prepaid balance
                // here, where the entry they'd click already is.
                badge: credits.usesKodusProvider ? (
                    <span
                        data-testid="nav-credits"
                        className={cn(
                            "text-xs tabular-nums",
                            credits.exhausted
                                ? "text-danger"
                                : credits.low
                                  ? "text-warning"
                                  : "text-text-tertiary",
                        )}>
                        {credits.exhausted
                            ? "Top up"
                            : typeof credits.balanceUsd === "number"
                              ? formatUsd(credits.balanceUsd)
                              : ""}
                    </span>
                ) : undefined,
            },
            {
                label: "Settings",
                icon: <SlidersHorizontalIcon className="size-5" />,
                href: "/settings",
                visible:
                    canReadCodeReviewSettings ||
                    canReadGitSettings ||
                    canReadBilling,
                // Plugins has its own entry below; keep it out of Settings'
                // active state.
                matcher: (path) =>
                    path.startsWith("/settings") &&
                    !path.startsWith("/settings/plugins"),
            },
            {
                label: "Plugins",
                icon: <BlocksIcon className="size-5" />,
                href: "/settings/plugins",
                visible: canReadPlugins && isMCPAvailable,
                badge: (
                    <span className="bg-secondary-light/15 text-secondary-light rounded-full px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase">
                        Beta
                    </span>
                ),
            },
        ];

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
        isMCPAvailable,
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
            <div className="-mb-1 h-full min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto [&::-webkit-scrollbar]:hidden">
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
                <CommandPalette />

                <div className="hidden md:flex">
                    <ErrorBoundary fallback={null}>
                        <GithubStars />
                    </ErrorBoundary>
                </div>

                <div className="flex items-center gap-1">
                    <div className="hidden sm:flex">
                        <SubscriptionBadge />
                    </div>
                    <NotificationBell />
                </div>

                <UserNav />
            </div>
        </div>
    );
};
