/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { render, screen } from "@testing-library/react";

import { CustomAgentsSectionGate } from "./custom-agents-plan-gate";

let mockLicense: Record<string, unknown>;
jest.mock("src/features/ee/subscription/_providers/subscription-context", () => ({
    useSubscriptionContext: () => ({ license: mockLicense }),
}));

const captureGateHit = jest.fn();
jest.mock("src/core/utils/gate-hit", () => ({
    captureGateHit: (...args: unknown[]) => captureGateHit(...args),
    captureGateCtaClick: jest.fn(),
}));

jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));

jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ href, children, ...rest }: any) => (
        <a href={href} {...rest}>
            {children}
        </a>
    ),
}));

const renderSection = () =>
    render(
        <CustomAgentsSectionGate>
            <p>Ledger reviewer</p>
        </CustomAgentsSectionGate>,
    );

describe("Custom agents section on What to review", () => {
    beforeEach(() => captureGateHit.mockReset());

    it.each([
        ["free", { valid: true, subscriptionStatus: "active", planType: "free_byok" }],
        ["a canceled Teams plan", { valid: true, subscriptionStatus: "canceled", planType: "teams_byok" }],
    ])("on %s, is locked without the saved agents", (_, license) => {
        mockLicense = license;
        renderSection();

        expect(
            screen.getByRole("heading", { name: "Unlock custom agents" }),
        ).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "See plans" })).toHaveAttribute(
            "href",
            "/choose-plan",
        );
        expect(screen.queryByText("Ledger reviewer")).toBeNull();
        expect(captureGateHit).toHaveBeenCalledWith(
            expect.objectContaining({
                feature: "custom_agents",
                surface: "settings_general",
            }),
        );
    });

    it.each([
        ["a trial", { valid: true, subscriptionStatus: "trial", planType: "teams_managed" }],
        ["Teams", { valid: true, subscriptionStatus: "active", planType: "teams_byok" }],
        ["Enterprise", { valid: true, subscriptionStatus: "active", planType: "enterprise_managed" }],
    ])("on %s, shows the agents", (_, license) => {
        mockLicense = license;
        renderSection();

        expect(screen.getByText("Ledger reviewer")).toBeInTheDocument();
        expect(screen.queryByText("Unlock custom agents")).toBeNull();
        expect(captureGateHit).not.toHaveBeenCalled();
    });
});
