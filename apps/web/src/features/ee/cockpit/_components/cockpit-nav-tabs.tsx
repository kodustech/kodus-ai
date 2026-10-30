"use client";

import { Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { LinkTab, LinkTabs } from "@components/ui/link-tabs";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { IssuesCount } from "src/core/layout/navbar/_components/issues-count";

import { COCKPIT_PARAM, tabs, type TabValue } from "../_constants";

/**
 * Issues lives inside the Cockpit. The Cockpit itself keeps its in-page
 * Radix tabs (every panel is force-mounted); this link-tab strip is what the
 * Issues route renders so it reads as the third tab of the same area, and
 * the cockpit layout appends the Issues link to its own TabsList.
 */
export const IssuesTabLink = ({ active }: { active: boolean }) => {
    const canReadIssues = usePermission(Action.Read, ResourceType.Issues);
    if (!canReadIssues) return null;

    return (
        <LinkTab
            href="/issues"
            active={active}
            trailing={
                <span className="inline-flex h-5 min-w-6 items-center">
                    <Suspense fallback={null}>
                        <IssuesCount />
                    </Suspense>
                </span>
            }>
            Issues
        </LinkTab>
    );
};

export const CockpitNavTabs = ({
    visibleTabs,
}: {
    visibleTabs?: TabValue[];
}) => {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const onIssues = pathname.startsWith("/issues");
    const currentTab = searchParams.get(COCKPIT_PARAM.tab);
    const entries = (Object.entries(tabs) as Array<[TabValue, string]>).filter(
        ([value]) => !visibleTabs || visibleTabs.includes(value),
    );

    return (
        <LinkTabs aria-label="Cockpit sections" className="w-full">
            {entries.map(([value, name], index) => (
                <LinkTab
                    key={value}
                    href={`/cockpit?${COCKPIT_PARAM.tab}=${value}`}
                    active={
                        !onIssues &&
                        (currentTab === value || (!currentTab && index === 0))
                    }>
                    {name}
                </LinkTab>
            ))}
            <IssuesTabLink active={onIssues} />
        </LinkTabs>
    );
};
