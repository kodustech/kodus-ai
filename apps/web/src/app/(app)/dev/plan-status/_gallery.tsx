"use client";

import { Page } from "@components/ui/page";
import { SidebarPlanStatus } from "src/core/layout/sidebar/plan-status";
import { buildPlanFixtures } from "src/core/layout/sidebar/plan-status.fixtures";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

export const PlanStatusGallery = () => (
    <Page.Root>
        <Page.Header>
            <Page.TitleContainer>
                <Page.Title>Plan status</Page.Title>
                <Page.Description>
                    The sidebar&apos;s plan panel in every billing state,
                    expanded and in the rail. Fixtures live in
                    plan-status.fixtures.ts.
                </Page.Description>
            </Page.TitleContainer>
        </Page.Header>
        <Page.Content>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(19rem,1fr))] gap-4">
                {buildPlanFixtures().map((fixture) => (
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
                                    <SidebarPlanStatus collapsed={false} />
                                </div>
                                <div className="bg-card-lv1 flex w-14 shrink-0 justify-center rounded-lg py-2">
                                    <SidebarPlanStatus collapsed />
                                </div>
                            </div>
                        </SubscriptionProvider>
                    </li>
                ))}
            </ul>
        </Page.Content>
    </Page.Root>
);
