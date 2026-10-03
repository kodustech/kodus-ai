/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { LockedFeatureOverlay } from "./locked-feature-overlay";

const mockCanOpenBilling = { value: true };
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => mockCanOpenBilling.value,
}));

jest.mock("src/core/utils/gate-hit", () => ({
    captureGateCtaClick: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { captureGateCtaClick } = require("src/core/utils/gate-hit");

describe("LockedFeatureOverlay", () => {
    it("renders the title, description, and children behind the blur", () => {
        render(
            <LockedFeatureOverlay
                title="Unlock the Cockpit"
                description="Engineering metrics are available on Teams and Enterprise plans.">
                <div data-testid="gated-content">real dashboard</div>
            </LockedFeatureOverlay>,
        );

        expect(screen.getByText("Unlock the Cockpit")).toBeInTheDocument();
        expect(
            screen.getByText(
                "Engineering metrics are available on Teams and Enterprise plans.",
            ),
        ).toBeInTheDocument();
        // Content still renders (blurred, not removed) — the gate is
        // visual-only, never hides the preview from the DOM.
        expect(screen.getByTestId("gated-content")).toBeInTheDocument();
    });

    it("marks the blurred layer aria-hidden so screen readers skip the decoy content", () => {
        const { container } = render(
            <LockedFeatureOverlay title="Locked" description="desc">
                <span>decoy</span>
            </LockedFeatureOverlay>,
        );

        const hiddenLayer = container.querySelector('[aria-hidden="true"]');
        expect(hiddenLayer).not.toBeNull();
        expect(hiddenLayer).toHaveTextContent("decoy");
    });

    it("renders the upgrade CTA linking to the given href when provided", () => {
        render(
            <LockedFeatureOverlay
                title="Locked"
                description="desc"
                cta={{
                    label: "Upgrade plan",
                    href: "/settings/subscription",
                    feature: "cockpit",
                }}>
                <span>content</span>
            </LockedFeatureOverlay>,
        );

        const link = screen.getByRole("link", { name: /upgrade plan/i });
        expect(link).toHaveAttribute("href", "/settings/subscription");
    });

    it("tells a viewer without billing access to ask an admin instead of linking to plans", () => {
        mockCanOpenBilling.value = false;
        try {
            render(
                <LockedFeatureOverlay
                    title="Locked"
                    description="desc"
                    cta={{
                        label: "See plans",
                        href: "/choose-plan",
                        feature: "cockpit",
                    }}>
                    <span>content</span>
                </LockedFeatureOverlay>,
            );

            expect(screen.queryByRole("link")).not.toBeInTheDocument();
            expect(
                screen.getByText(
                    "Ask an organization admin to upgrade the plan.",
                ),
            ).toBeInTheDocument();
        } finally {
            mockCanOpenBilling.value = true;
        }
    });

    it("drops an alternative that leads to billing for a viewer without access", () => {
        mockCanOpenBilling.value = false;
        try {
            render(
                <LockedFeatureOverlay
                    title="Locked"
                    description="desc"
                    altCta={{ label: "Compare plans", href: "/choose-plan" }}>
                    <span>content</span>
                </LockedFeatureOverlay>,
            );

            expect(screen.queryByRole("link")).not.toBeInTheDocument();
        } finally {
            mockCanOpenBilling.value = true;
        }
    });

    it("tracks a gate_cta_click when the CTA is clicked", () => {
        render(
            <LockedFeatureOverlay
                title="Locked"
                description="desc"
                cta={{
                    label: "Upgrade plan",
                    href: "/settings/subscription",
                    feature: "cockpit",
                    surface: "locked_preview",
                    subscriptionStatus: "trial",
                }}>
                <span>content</span>
            </LockedFeatureOverlay>,
        );

        fireEvent.click(screen.getByText(/upgrade plan/i));

        expect(captureGateCtaClick).toHaveBeenCalledWith(
            expect.objectContaining({
                feature: "cockpit",
                surface: "locked_preview",
                subscriptionStatus: "trial",
            }),
        );
    });

    it("omits the CTA entirely when none is given", () => {
        render(
            <LockedFeatureOverlay title="Locked" description="desc">
                <span>content</span>
            </LockedFeatureOverlay>,
        );

        expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });
});
