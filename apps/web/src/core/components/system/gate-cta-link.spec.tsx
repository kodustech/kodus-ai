/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { GateAltLink, GateCtaLink } from "./gate-cta-link";

jest.mock("src/core/utils/gate-hit", () => ({
    captureGateCtaClick: jest.fn(),
}));

const mockCanOpenBilling = { value: true };
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => mockCanOpenBilling.value,
}));

const mockSelfHosted = { value: false };
jest.mock("src/core/utils/self-hosted", () => ({
    get isSelfHosted() {
        return mockSelfHosted.value;
    },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { captureGateCtaClick } = require("src/core/utils/gate-hit");

describe("GateCtaLink", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockCanOpenBilling.value = true;
        mockSelfHosted.value = false;
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

    describe("for someone who cannot open billing", () => {
        beforeEach(() => {
            mockCanOpenBilling.value = false;
        });

        it.each([
            "/choose-plan",
            "/settings/subscription",
            "/settings/subscription?tab=members",
        ])("points them at an admin instead of linking to %s", (href) => {
            render(<GateCtaLink feature="cockpit" href={href} />);

            expect(screen.queryByRole("link")).not.toBeInTheDocument();
            expect(
                screen.getByText(
                    "Ask an organization admin to upgrade the plan.",
                ),
            ).toBeInTheDocument();
        });

        it("asks for a license on self-hosted", () => {
            mockSelfHosted.value = true;

            render(<GateCtaLink feature="cockpit" />);

            expect(
                screen.getByText(
                    "Ask an organization admin to activate a license.",
                ),
            ).toBeInTheDocument();
        });

        it("still links anywhere that is not billing", () => {
            render(
                <GateCtaLink feature="kody_rules" label="Open" href="/byok" />,
            );

            expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute(
                "href",
                "/byok",
            );
        });

        it("does not mistake a lookalike path for billing", () => {
            render(
                <GateCtaLink
                    feature="kody_rules"
                    label="Open"
                    href="/choose-planner"
                />,
            );

            expect(
                screen.getByRole("link", { name: /open/i }),
            ).toBeInTheDocument();
        });
    });
});

describe("GateAltLink", () => {
    beforeEach(() => {
        mockCanOpenBilling.value = true;
    });

    it("links to its target", () => {
        render(
            <GateAltLink href="/settings/git" label="Connect a repository" />,
        );

        expect(
            screen.getByRole("link", { name: /connect a repository/i }),
        ).toHaveAttribute("href", "/settings/git");
    });

    it("is offered when it leads to billing the viewer can open", () => {
        render(<GateAltLink href="/choose-plan" label="Compare plans" />);

        expect(
            screen.getByRole("link", { name: /compare plans/i }),
        ).toHaveAttribute("href", "/choose-plan");
    });

    it("is not offered when it leads to billing the viewer cannot open", () => {
        mockCanOpenBilling.value = false;

        const { container } = render(
            <GateAltLink href="/choose-plan" label="Compare plans" />,
        );

        expect(container).toBeEmptyDOMElement();
    });

    it("stays for anyone when it leads elsewhere", () => {
        mockCanOpenBilling.value = false;

        render(
            <GateAltLink href="/settings/git" label="Connect a repository" />,
        );

        expect(
            screen.getByRole("link", { name: /connect a repository/i }),
        ).toBeInTheDocument();
    });
});
