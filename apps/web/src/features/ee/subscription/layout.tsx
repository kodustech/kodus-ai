"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { isSelfHosted } from "src/core/utils/self-hosted";

import { InviteModal } from "./_components/invite-modal";
import { LicenseKeySettings } from "./_components/license-key-settings";
import { useSubscriptionStatus } from "./_hooks/use-subscription-status";
import { TableFilterContext } from "./_providers/table-filter-context";

const tabs = {
    prs: "pr-licenses",
    admins: "organization-admins",
} as const;

export default function SubscriptionLayout({
    status,
    admins,
    licenses,
}: {
    admins: React.ReactNode;
    status: React.ReactNode;
    licenses: React.ReactNode;
}) {
    const searchParams = useSearchParams();
    const [selectedTab, setSelectedTab] = useState<string>(
        tabs[searchParams.get("tab") as keyof typeof tabs] ?? tabs.prs,
    );
    const [query, setQuery] = useState("");
    const { teamId } = useSelectedTeamId();
    const canCreate = usePermission(Action.Create, ResourceType.UserSettings);
    const subscription = useSubscriptionStatus();

    const isLicensedSelfHosted =
        isSelfHosted && subscription.status === "licensed-self-hosted";
    const isUnlicensedSelfHosted =
        isSelfHosted && subscription.status === "self-hosted";

    // Unlicensed self-hosted: show only the license key input
    if (isUnlicensedSelfHosted)
        return (
            <Page.Root>
                <Page.Content>
                    <LicenseKeySettings />
                </Page.Content>
            </Page.Root>
        );

    // Licensed self-hosted: show license settings + seat management tabs
    if (isLicensedSelfHosted)
        return (
            <Page.Root>
                <Page.Content>
                    <LicenseKeySettings />

                    <TableFilterContext value={{ query, setQuery }}>
                        <Tabs
                            value={selectedTab}
                            onValueChange={setSelectedTab}>
                            <TabsList className="mt-5">
                                <TabsTrigger value={tabs.prs}>
                                    PR licenses
                                </TabsTrigger>
                                <TabsTrigger value={tabs.admins}>
                                    Workspace members
                                </TabsTrigger>

                                <div className="mb-5 flex h-full flex-1 items-center justify-end">
                                    <div className="flex items-center gap-2">
                                        <Input
                                            size="md"
                                            value={query}
                                            className="w-52"
                                            leftIcon={<SearchIcon />}
                                            placeholder="Find by name"
                                            onChange={(e) =>
                                                setQuery(e.target.value)
                                            }
                                        />

                                        {selectedTab === tabs.admins && (
                                            <Button
                                                size="md"
                                                variant="helper"
                                                leftIcon={<PlusIcon />}
                                                disabled={!canCreate}
                                                onClick={() => {
                                                    magicModal.show(() => (
                                                        <InviteModal
                                                            teamId={teamId}
                                                        />
                                                    ));
                                                }}>
                                                Invite member
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </TabsList>

                            <TabsContent value={tabs.prs}>
                                <Suspense
                                    fallback={
                                        <Card className="flex h-40 flex-col items-center justify-center gap-3 bg-transparent shadow-none">
                                            <Spinner />
                                            <p className="text-sm">
                                                Loading users...
                                            </p>
                                        </Card>
                                    }>
                                    {licenses}
                                </Suspense>
                            </TabsContent>

                            <Suspense>
                                <TabsContent value={tabs.admins}>
                                    {admins}
                                </TabsContent>
                            </Suspense>
                        </Tabs>
                    </TableFilterContext>
                </Page.Content>
            </Page.Root>
        );

    // Cloud mode: show standard subscription UI
    return (
        <Page.Root>
            <Page.Header>{status}</Page.Header>

            <Page.Content>
                <TableFilterContext value={{ query, setQuery }}>
                    <Tabs value={selectedTab} onValueChange={setSelectedTab}>
                        <TabsList className="mt-5">
                            <TabsTrigger value={tabs.prs}>
                                PR licenses
                            </TabsTrigger>
                            <TabsTrigger value={tabs.admins}>
                                Workspace members
                            </TabsTrigger>

                            <div className="mb-5 flex h-full flex-1 items-center justify-end">
                                <div className="flex items-center gap-2">
                                    <Input
                                        size="md"
                                        value={query}
                                        className="w-52"
                                        leftIcon={<SearchIcon />}
                                        placeholder="Find by name"
                                        onChange={(e) =>
                                            setQuery(e.target.value)
                                        }
                                    />

                                    {selectedTab === tabs.admins && (
                                        <Button
                                            size="md"
                                            variant="helper"
                                            leftIcon={<PlusIcon />}
                                            disabled={!canCreate}
                                            onClick={() => {
                                                magicModal.show(() => (
                                                    <InviteModal
                                                        teamId={teamId}
                                                    />
                                                ));
                                            }}>
                                            Invite member
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </TabsList>

                        <TabsContent value={tabs.prs}>
                            <Suspense
                                fallback={
                                    <Card className="flex h-40 flex-col items-center justify-center gap-3 bg-transparent shadow-none">
                                        <Spinner />
                                        <p className="text-sm">
                                            Loading users...
                                        </p>
                                    </Card>
                                }>
                                {licenses}
                            </Suspense>
                        </TabsContent>

                        <Suspense>
                            <TabsContent value={tabs.admins}>
                                {admins}
                            </TabsContent>
                        </Suspense>
                    </Tabs>
                </TableFilterContext>
            </Page.Content>
        </Page.Root>
    );
}
