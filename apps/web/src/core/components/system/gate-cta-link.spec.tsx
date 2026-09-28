/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import { GateCtaLink } from "./gate-cta-link";

jest.mock("src/core/utils/gate-hit", () => ({
    captureGateCtaClick: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { captureGateCtaClick } = require("src/core/utils/gate-hit");

describe("GateCtaLink", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("renders with the default label and href", () => {
        render(<GateCtaLink feature="mcp_plugins" />);

        const link = screen.getByRole("link", { name: /upgrade plan/i });
        expect(link).toHaveAttribute("href", "/settings/subscription");
    });

    it("renders a custom label and href when given", () => {
        render(
            <GateCtaLink
                feature="kody_rules"
                label="See plans"
                href="/pricing"
            />,
        );

        const link = screen.getByRole("link", { name: /see plans/i });
        expect(link).toHaveAttribute("href", "/pricing");
    });

    it("fires captureGateCtaClick with the gate id, both plan fields and metadata", () => {
        render(
            <GateCtaLink
                feature="mcp_plugins"
                surface="locked_banner"
                planType="free_byok"
                subscriptionStatus="active"
                metadata={{ lockedCount: 1 }}
            />,
        );

        // The CTA renders as an anchor (real interactive element, for a11y)
        // wrapping a decorative <span> — the click handler lives on that
        // span, so click the label text (bubbles up) rather than the
        // outer link role (clicking an ancestor doesn't reach descendants).
        fireEvent.click(screen.getByText(/upgrade plan/i));

        expect(captureGateCtaClick).toHaveBeenCalledTimes(1);
        // Plan type and subscription status travel separately: "active"
        // alone cannot tell a Free org from a paying one.
        expect(captureGateCtaClick).toHaveBeenCalledWith({
            feature: "mcp_plugins",
            surface: "locked_banner",
            planType: "free_byok",
            subscriptionStatus: "active",
            metadata: { lockedCount: 1 },
        });
    });
});
