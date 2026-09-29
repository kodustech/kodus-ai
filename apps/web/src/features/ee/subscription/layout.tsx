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
    // Self-hosted "expired" is the license key's, not a cloud plan's: it
    // belongs on the license page, not on "choose a plan".
    const isExpiredSelfHosted =
        isSelfHosted && subscription.status === "expired";

    const tableTools = (
        <div className="flex w-full items-center gap-2 md:w-auto">
            <Input
                size="md"
                value={query}
                className="min-w-0 flex-1 md:w-52 md:flex-none"
                leftIcon={<SearchIcon />}
                placeholder="Find by name"
                onChange={(e) => setQuery(e.target.value)}
            />

            {selectedTab === tabs.admins && (
                <Button
                    size="md"
                    variant="helper"
                    leftIcon={<PlusIcon />}
                    disabled={!canCreate}
                    onClick={() => {
                        magicModal.show(() => <InviteModal teamId={teamId} />);
                    }}>
                    Invite member
                </Button>
            )}
        </div>
    );

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Subscription</Page.Title>
                    <Page.Description>
                        Your plan, and who holds a review seat.
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>

            <Page.Content>
                {/* Self-hosted reads its plan from the license key, cloud
                    from billing; both land in the same plan sheet. */}
                {isLicensedSelfHosted ||
                isUnlicensedSelfHosted ||
                isExpiredSelfHosted ? (
                    <LicenseKeySettings />
                ) : (
                    status
                )}

                {/* Seats only exist once a plan has them: an unlicensed
                    self-hosted instance has nothing to assign. */}
                {!isUnlicensedSelfHosted && (
                    <TableFilterContext value={{ query, setQuery }}>
                        <Tabs
                            value={selectedTab}
                            onValueChange={setSelectedTab}>
                            {/* On a phone the search can't share the tab
                                row without scrolling it sideways, so it takes
                                its own line above. */}
                            <div className="mt-5 flex md:hidden">
                                {tableTools}
                            </div>
                            <TabsList className="mt-3 md:mt-5">
                                <TabsTrigger value={tabs.prs}>
                                    PR licenses
                                </TabsTrigger>
                                <TabsTrigger value={tabs.admins}>
                                    Workspace members
                                </TabsTrigger>

                                <div className="mb-5 hidden h-full flex-1 items-center justify-end md:flex">
                                    {tableTools}
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
                )}
            </Page.Content>
        </Page.Root>
    );
}
