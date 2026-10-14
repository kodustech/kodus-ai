/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { TooltipProvider } from "@components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import { SubscriptionProvider } from "src/features/ee/subscription/_providers/subscription-context";

import { SidebarPlanStatus } from "./plan-status";

// A self-hosted build: the license service, not billing, answers here.
jest.mock("src/core/utils/self-hosted", () => ({
    ...jest.requireActual("src/core/utils/self-hosted"),
    isSelfHosted: true,
}));

const renderExpired = (collapsed = false) =>
    render(
        <TooltipProvider>
            <SubscriptionProvider
                // What the license service answers for an expired key.
                license={{
                    valid: false,
                    subscriptionStatus: "expired",
                    numberOfLicenses: 0,
                }}
                usersWithAssignedLicense={[]}>
                <SidebarPlanStatus collapsed={collapsed} />
            </SubscriptionProvider>
        </TooltipProvider>,
    );

describe("SidebarPlanStatus on self-hosted", () => {
    it("reads an expired license key as that, not as a cloud trial", () => {
        renderExpired();

        const panel = screen.getByRole("link");
        expect(panel).toHaveTextContent("License expired");
        expect(panel).toHaveTextContent("Paste a renewed key");
        expect(panel).not.toHaveTextContent("Trial ended");
        expect(panel).not.toHaveTextContent("Choose a plan");
    });

    it("names it in the collapsed rail too", () => {
        renderExpired(true);

        expect(screen.getByRole("link")).toHaveAccessibleName(
            "Enterprise · self-hosted · License expired",
        );
    });
});
