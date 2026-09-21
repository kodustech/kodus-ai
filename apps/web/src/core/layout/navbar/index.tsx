"use client";

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import { SvgKodus } from "@components/ui/icons/SvgKodus";
import {
    NavigationMenu,
    NavigationMenuItem,
    NavigationMenuLink,
    NavigationMenuList,
} from "@components/ui/navigation-menu";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "react-error-boundary";
import { UserNav } from "src/core/layout/navbar/_components/user-nav";
import { cn } from "src/core/utils/components";
import { SubscriptionBadge } from "src/features/ee/subscription/_components/subscription-badge";

import { CommandPalette } from "./_components/command-palette";
import { GithubStars } from "./_components/github-stars";
import { NotificationBell } from "./_components/notification-bell";
import { VERSION_QUERY } from "./_components/version-info";
import { useMainNavItems } from "./use-main-nav-items";

export const NavMenu = () => {
    const pathname = usePathname();
    const queryClient = useQueryClient();
    queryClient.prefetchQuery(VERSION_QUERY);

    const items = useMainNavItems();

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
                                icon: Icon,
                                navbarIconClassName,
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
                                            <Icon
                                                className={
                                                    navbarIconClassName ??
                                                    "size-5"
                                                }
                                            />
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
