/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { TooltipProvider } from "@components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { SidebarPlanStatus } from "./plan-status";
import { buildPlanFixtures, type PlanFixture } from "./plan-status.fixtures";

const fixtures = new Map(buildPlanFixtures().map((item) => [item.id, item]));

// Every panel opens the subscription page, except a trial out of free
// reviews: a key of its own is what brings reviews back.
const hrefFor = (id: string) =>
    id === "trial-exhausted" ? "/byok" : "/settings/subscription";

const renderPlan = (id: string, collapsed = false) => {
    const fixture = fixtures.get(id) as PlanFixture;
    return render(
        <TooltipProvider>
            <SubscriptionProvider
                license={fixture.license}
                usersWithAssignedLicense={fixture.usersWithAssignedLicense}>
                <SidebarPlanStatus collapsed={collapsed} />
            </SubscriptionProvider>
        </TooltipProvider>,
    );
};

describe("SidebarPlanStatus", () => {
    // Expanded: the tier chip plus the one fact billing gives for it.
    it.each([
        [
            "trial-active",
            ["Trial", "12 days left", "7 of 10 free reviews left"],
        ],
        ["trial-byok", ["Trial", "9 days left", "BYOK · unlimited reviews"]],
        ["trial-expiring", ["Trial", "2 days left", "Choose a plan"]],
        [
            "trial-exhausted",
            ["Trial", "Free reviews used up", "Connect your AI key"],
        ],
        ["free", ["Free", "BYOK", "Upgrade plan"]],
        ["teams", ["Teams", "Managed", "12 of 25 seats in use"]],
        ["teams-byok", ["Teams", "BYOK", "10 of 10 seats in use"]],
        ["enterprise", ["Enterprise", "Managed", "143 of 200 seats in use"]],
        ["community", ["Community", "Self-hosted"]],
        [
            "enterprise-self-hosted",
            [
                "Enterprise",
                "Self-hosted",
                "31 of 50 seats in use",
                "License · 212 days left",
            ],
        ],
        ["enterprise-self-hosted-ending", ["License · 18 days left"]],
        ["payment-failed", ["Payment failed"]],
        ["canceled", ["Canceled", "Reviews are paused.", "Choose a plan"]],
        ["expired", ["Expired", "Reviews are paused.", "Choose a plan"]],
        ["inactive", ["Unconfirmed", "Billing didn't answer."]],
    ])("%s shows its tier and fact", (id, texts) => {
        renderPlan(id);

        const panel = screen.getByRole("link");
        expect(panel).toHaveAttribute("href", hrefFor(id));
        for (const text of texts) expect(panel).toHaveTextContent(text);
    });

    it.each([...fixtures.keys()])(
        "%s keeps a named tile in the collapsed rail",
        (id) => {
            renderPlan(id, true);

            const tile = screen.getByRole("link");
            expect(tile).toHaveAttribute("href", hrefFor(id));
            expect(tile.getAttribute("aria-label")).toMatch(/\S/);
        },
    );

    it("sends a trial out of free reviews to connect a key, not to a plan", () => {
        renderPlan("trial-exhausted");
        expect(screen.getByRole("link")).toHaveAttribute("href", "/byok");
        expect(screen.getByRole("link")).not.toHaveTextContent("Choose a plan");
    });

    it("names the tier in the rail tile's label", () => {
        renderPlan("teams", true);
        expect(screen.getByRole("link")).toHaveAccessibleName(
            "Teams plan · Managed · 12 of 25 seats in use",
        );
    });
});
