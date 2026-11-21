"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Heading } from "@components/ui/heading";
import { LinkTab, LinkTabs } from "@components/ui/link-tabs";
import { Page } from "@components/ui/page";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";

/** Title and section tabs shared by every Kody Runtime list screen. */
export const RuntimeHeader = ({ actions }: { actions?: ReactNode }) => {
    const pathname = usePathname();
    const tabs = [
        {
            href: "/runtime/runs",
            label: "Runs",
            visible: usePermission(Action.Read, ResourceType.RuntimeRun),
        },
        {
            href: "/runtime/environments",
            label: "Environments",
            visible: usePermission(
                Action.Read,
                ResourceType.RuntimeEnvironment,
            ),
        },
        {
            href: "/runtime/settings",
            label: "Settings",
            visible: usePermission(
                Action.Read,
                ResourceType.CodeReviewSettings,
            ),
        },
    ].filter((tab) => tab.visible);
    return (
        <Page.Header>
            <div className="flex flex-col gap-2">
                <Heading variant="h1">Kody Runtime</Heading>
                <LinkTabs
                    aria-label="Kody Runtime sections"
                    className="-ml-4 shadow-none">
                    {tabs.map((tab) => (
                        <LinkTab
                            key={tab.href}
                            href={tab.href}
                            prefetch
                            active={pathname.startsWith(tab.href)}>
                            {tab.label}
                        </LinkTab>
                    ))}
                </LinkTabs>
            </div>
            {actions && <Page.HeaderActions>{actions}</Page.HeaderActions>}
        </Page.Header>
    );
};
