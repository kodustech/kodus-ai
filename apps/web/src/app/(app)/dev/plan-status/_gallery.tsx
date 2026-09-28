"use client";

import { Page } from "@components/ui/page";
import type { TeamMembersResponse } from "@services/setup/types";
import { SidebarPlanStatus } from "src/core/layout/sidebar/plan-status";
import { buildPlanFixtures } from "src/core/layout/sidebar/plan-status.fixtures";
import { LicenseKeySettings } from "src/features/ee/subscription/_components/license-key-settings";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";
import { Redirect as SubscriptionStatus } from "src/features/ee/subscription/@status/_components";

// Three workspace members, enough for the members fact to read as real.
const MEMBERS = Array.from({ length: 3 }, (_, index) => ({
    uuid: `member-${index}`,
    email: `member-${index}@example.com`,
})) as unknown as TeamMembersResponse["members"];

const SELF_HOSTED = new Set([
    "community",
    "enterprise-self-hosted",
    "enterprise-self-hosted-ending",
    "enterprise-self-hosted-expired",
]);

export const PlanStatusGallery = () => {
    const fixtures = buildPlanFixtures();

    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Page.Title>Plan status</Page.Title>
                    <Page.Description>
                        The sidebar&apos;s plan panel and the subscription
                        page&apos;s plan sheet in every billing state. Fixtures
                        live in plan-status.fixtures.ts.
                    </Page.Description>
                </Page.TitleContainer>
            </Page.Header>
            <Page.Content>
                <section
                    aria-labelledby="gallery-sidebar"
                    className="flex flex-col gap-4">
                    <h2
                        id="gallery-sidebar"
                        className="text-text-primary text-base font-semibold">
                        Sidebar panel
                    </h2>
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-4">
                        {fixtures.map((fixture) => (
                            <li
                                key={fixture.id}
                                className="border-card-lv3/60 flex flex-col gap-3 rounded-xl border p-4">
                                <span className="text-text-secondary text-sm font-medium">
                                    {fixture.title}
                                </span>
                                <SubscriptionProvider
                                    license={fixture.license}
                                    usersWithAssignedLicense={
                                        fixture.usersWithAssignedLicense
                                    }>
                                    {/* The sidebar foot's own widths and surface. */}
                                    <div className="flex items-end gap-3">
                                        <div className="bg-card-lv1 w-60 shrink-0 rounded-lg px-2 py-2">
                                            <SidebarPlanStatus
                                                collapsed={false}
                                            />
                                        </div>
                                        <div className="bg-card-lv1 flex w-14 shrink-0 justify-center rounded-lg py-2">
                                            <SidebarPlanStatus collapsed />
                                        </div>
                                    </div>
                                </SubscriptionProvider>
                            </li>
                        ))}
                    </ul>
                </section>

                <section
                    aria-labelledby="gallery-page"
                    className="mt-10 flex flex-col gap-4">
                    <h2
                        id="gallery-page"
                        className="text-text-primary text-base font-semibold">
                        Subscription page
                    </h2>
                    <ul className="flex flex-col gap-8">
                        {/* Self-hosted only: the license service's answer
                            to an expired key (on a self-hosted build the page
                            routes it here; the sidebar is covered by its own
                            spec). */}
                        <li className="flex flex-col gap-3">
                            <span className="text-text-secondary text-sm font-medium">
                                Self-hosted · license key expired
                            </span>
                            <SubscriptionProvider
                                license={{
                                    valid: false,
                                    subscriptionStatus: "expired",
                                    numberOfLicenses: 0,
                                }}
                                usersWithAssignedLicense={[]}>
                                <LicenseKeySettings />
                            </SubscriptionProvider>
                        </li>
                        {fixtures.map((fixture) => (
                            <li
                                key={fixture.id}
                                className="flex flex-col gap-3">
                                <span className="text-text-secondary text-sm font-medium">
                                    {fixture.title}
                                </span>
                                <SubscriptionProvider
                                    license={fixture.license}
                                    usersWithAssignedLicense={
                                        fixture.usersWithAssignedLicense
                                    }>
                                    {/* What the page renders in that state:
                                        the license key settings on
                                        self-hosted, billing's status on
                                        cloud. */}
                                    {SELF_HOSTED.has(fixture.id) ? (
                                        <LicenseKeySettings />
                                    ) : (
                                        <SubscriptionStatus members={MEMBERS} />
                                    )}
                                </SubscriptionProvider>
                            </li>
                        ))}
                    </ul>
                </section>
            </Page.Content>
        </Page.Root>
    );
};
