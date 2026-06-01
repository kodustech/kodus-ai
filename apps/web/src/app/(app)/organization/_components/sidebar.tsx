"use client";

import type { Route } from "next";
import { usePathname } from "next/navigation";
import { Button } from "@components/ui/button";
import { Link } from "@components/ui/link";
import { Separator } from "@components/ui/separator";
import {
    Sidebar,
    SidebarContent,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
} from "@components/ui/sidebar";
import {
    BellIcon,
    CogIcon,
    GaugeIcon,
    KeyRoundIcon,
    LockKeyholeOpenIcon,
    ShieldIcon,
} from "lucide-react";
import {
    isBYOKSubscriptionPlan,
    isEnterprisePlan,
} from "src/features/ee/byok/_utils";
import { useSubscriptionContext } from "src/features/ee/subscription/_providers/subscription-context";
import { useOrganizationContext } from "src/features/organization/_providers/organization-context";

export const ConfigsSidebar = () => {
    const { organizationName } = useOrganizationContext();
    const pathname = usePathname();
    const { license } = useSubscriptionContext();
    const isTrial = license.subscriptionStatus === "trial";
    const isBYOK = isBYOKSubscriptionPlan(license);
    const isEnterprise = isEnterprisePlan(license);

    const topItems = [
        {
            icon: CogIcon,
            label: "General",
            href: `/organization/general`,
            visible: true,
        },
        {
            icon: ShieldIcon,
            label: "SSO",
            href: `/organization/sso`,
            visible: isEnterprise || isTrial,
        },
        {
            icon: GaugeIcon,
            label: "Cockpit",
            href: `/organization/cockpit`,
            visible: true,
        },
        {
            icon: LockKeyholeOpenIcon,
            label: "BYOK",
            href: `/organization/byok`,
            visible: true,
        },
        {
            icon: KeyRoundIcon,
            label: "CLI keys",
            href: `/organization/cli-keys`,
            visible: true,
        },
        {
            icon: BellIcon,
            label: "Notifications",
            href: `/organization/notifications`,
            visible: true,
        },
    ] satisfies Array<{
        icon: React.ComponentType;
        label: string;
        href: Route;
        visible: boolean;
    }>;

    return (
        <Sidebar className="bg-card-lv1">
            <SidebarContent className="gap-4">
                <SidebarGroupLabel>Settings</SidebarGroupLabel>
                <SidebarGroupLabel className="flex h-auto flex-col items-start gap-1 text-sm">
                    <strong className="text-text-secondary text-xs uppercase">
                        Organization
                    </strong>
                    <span>{organizationName}</span>
                </SidebarGroupLabel>

                <Separator />

                <SidebarGroup>
                    <SidebarGroupContent>
                        <SidebarMenu>
                            {topItems
                                .filter((item) => item.visible)
                                .map(({ icon: Icon, ...project }) => {
                                    const selected = pathname.startsWith(
                                        project.href,
                                    );

                                    return (
                                        <SidebarMenuItem key={project.label}>
                                            <Link href={project.href}>
                                                <Button
                                                    size="md"
                                                    decorative
                                                    leftIcon={<Icon />}
                                                    active={selected}
                                                    className="w-full justify-start border-none"
                                                    variant={
                                                        selected
                                                            ? "helper"
                                                            : "cancel"
                                                    }>
                                                    {project.label}
                                                </Button>
                                            </Link>
                                        </SidebarMenuItem>
                                    );
                                })}
                        </SidebarMenu>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>
        </Sidebar>
    );
};
