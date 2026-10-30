"use client";

import type { ComponentProps, ReactNode } from "react";
import NextLink from "next/link";
import { cn } from "src/core/utils/components";
import {
    hasUnsavedChanges,
    triggerNavigationBlock,
} from "src/core/utils/navigation-guard";

/**
 * Navigation-flavoured tabs: the same underline voice as the DS `Tabs`, but
 * each tab is a link to a route (Radix Tabs is value-based and meant for
 * in-page panels). Used by the settings page nav, the Reviews source
 * switcher and the Cockpit strip on the Issues page.
 */
export const LinkTabs = ({
    className,
    children,
    ...props
}: ComponentProps<"nav">) => (
    <nav
        {...props}
        className={cn(
            // The baseline is an inset shadow rather than a border: the active
            // tab's underline then sits on the same 2px without a negative
            // margin, and the strip can scroll sideways on narrow screens
            // without those 2px turning into a vertical scrollbar.
            "flex h-10 [scrollbar-width:none] items-center gap-1 overflow-x-auto",
            "shadow-[inset_0_-2px_0_0_var(--color-gray-200)]",
            className,
        )}>
        {children}
    </nav>
);

export const LinkTab = ({
    href,
    active,
    children,
    trailing,
    className,
    ...props
}: Omit<ComponentProps<typeof NextLink>, "href"> & {
    href: string;
    active: boolean;
    /** Badge / count rendered after the label. */
    trailing?: ReactNode;
}) => (
    <NextLink
        {...props}
        href={href}
        // Same guard as the DS Link: leaving a dirty form scrolls to the
        // unsaved field instead of navigating.
        onClick={(event) => {
            if (hasUnsavedChanges()) {
                event.preventDefault();
                triggerNavigationBlock();
                return;
            }
            props.onClick?.(event);
        }}
        aria-current={active ? "page" : undefined}
        data-active={active ? "true" : undefined}
        className={cn(
            "group text-text-secondary hover:text-text-primary focus-visible:ring-ring inline-flex h-10 shrink-0 items-center border-b-2 border-transparent text-sm font-medium whitespace-nowrap transition focus-visible:ring-2 focus-visible:outline-none",
            "data-[active=true]:border-primary-light data-[active=true]:text-text-primary",
            className,
        )}>
        <span className="group-hover:bg-card-lv1 mb-1 flex items-center gap-2 rounded-xl px-4 py-2 transition-colors">
            {children}
            {trailing}
        </span>
    </NextLink>
);
