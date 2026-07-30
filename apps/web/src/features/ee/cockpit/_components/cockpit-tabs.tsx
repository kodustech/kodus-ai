"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Tabs } from "@components/ui/tabs";

import { COCKPIT_PARAM, type TabValue } from "../_constants";

type Props = React.PropsWithChildren & {
    defaultTab: TabValue;
    visibleTabs: TabValue[];
};

/**
 * URL-aware wrapper around the cockpit Tabs root so the active tab is
 * shareable (`?tab=...`). The URL is the source of truth on load; an
 * unknown/hidden tab falls back to `defaultTab`.
 *
 * Switching tabs is purely visual — every panel is force-mounted — so we
 * update the URL with `history.replaceState` (shallow) instead of a
 * router navigation, avoiding a needless server re-render of every slot.
 */
export const CockpitTabs = ({ defaultTab, visibleTabs, children }: Props) => {
    const pathname = usePathname();
    const searchParams = useSearchParams();

    // Derive the active tab from the URL every render so it stays in sync
    // with browser back/forward and shared links (URL is source of truth).
    const urlTab = searchParams.get(COCKPIT_PARAM.tab) as TabValue | null;
    const value: TabValue =
        urlTab && visibleTabs.includes(urlTab) ? urlTab : defaultTab;

    const onValueChange = (next: string) => {
        // Build from the live query string so a concurrent shallow filter
        // update isn't clobbered (see useShallowParam).
        const params = new URLSearchParams(window.location.search);
        params.set(COCKPIT_PARAM.tab, next);
        window.history.replaceState(
            null,
            "",
            `${pathname}?${params.toString()}`,
        );
    };

    return (
        <Tabs value={value} onValueChange={onValueChange}>
            {children}
        </Tabs>
    );
};
