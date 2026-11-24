/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { toast } from "@components/ui/toaster/use-toast";
import { setFixedEgressIp } from "@services/codeManagement/fixedEgressIp";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { FixedEgressIpCard } from "./fixed-egress-ip-card";

jest.mock("@services/codeManagement/fixedEgressIp", () => ({
    setFixedEgressIp: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: jest.fn() }),
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team-1" }),
}));
const mockDeployment = { selfHosted: false };
jest.mock("src/core/utils/self-hosted", () => ({
    get isSelfHosted() {
        return mockDeployment.selfHosted;
    },
}));

const setMock = setFixedEgressIp as jest.MockedFunction<
    typeof setFixedEgressIp
>;

const paid = {
    available: true,
    allowedByPlan: true,
    enabled: false,
    fixedIp: "203.0.113.10",
};

describe("FixedEgressIpCard", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDeployment.selfHosted = false;
    });

    it("is not shown where sandboxes never leave through Kodus's network", () => {
        const { container } = render(
            <FixedEgressIpCard
                initialSetting={{
                    available: false,
                    allowedByPlan: false,
                    enabled: false,
                }}
            />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("says the setting could not be loaded instead of hiding it", () => {
        const none = { available: false, allowedByPlan: false, enabled: false };
        render(<FixedEgressIpCard initialSetting={none} loadFailed />);
        expect(screen.getByText("Fixed outbound IP")).toBeInTheDocument();
        expect(
            screen.getByText(/could not load this setting/i),
        ).toBeInTheDocument();
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    });

    it("stays hidden on a self-hosted install even when the read failed", () => {
        mockDeployment.selfHosted = true;
        const none = { available: false, allowedByPlan: false, enabled: false };
        const { container } = render(
            <FixedEgressIpCard initialSetting={none} loadFailed />,
        );
        expect(container).toBeEmptyDOMElement();
    });

    it("cannot be turned on from a plan without it, and points to the plans", () => {
        render(
            <FixedEgressIpCard
                initialSetting={{
                    available: true,
                    allowedByPlan: false,
                    enabled: false,
                    fixedIp: "203.0.113.10",
                }}
            />,
        );
        expect(screen.getByRole("switch")).toBeDisabled();
        expect(screen.getByText("See plans")).toBeInTheDocument();
        expect(screen.queryByText("203.0.113.10")).not.toBeInTheDocument();
    });

    it("shows a paying team the IP to allowlist and turns it on", async () => {
        setMock.mockResolvedValue({ ...paid, enabled: true });
        render(<FixedEgressIpCard initialSetting={paid} />);

        expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("switch"));

        await waitFor(() =>
            expect(setMock).toHaveBeenCalledWith({
                teamId: "team-1",
                enabled: true,
            }),
        );
        await waitFor(() =>
            expect(screen.getByRole("switch")).toHaveAttribute(
                "aria-checked",
                "true",
            ),
        );
    });

    it("says why when the API refuses, and stays off", async () => {
        setMock.mockRejectedValue({
            response: {
                data: { message: "Available on Teams and Enterprise." },
            },
        });
        render(<FixedEgressIpCard initialSetting={paid} />);

        fireEvent.click(screen.getByRole("switch"));

        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith(
                expect.objectContaining({
                    variant: "danger",
                    description: "Available on Teams and Enterprise.",
                }),
            ),
        );
        expect(screen.getByRole("switch")).toHaveAttribute(
            "aria-checked",
            "false",
        );
    });

    it("says when Kody turned it on after a refused clone", () => {
        render(
            <FixedEgressIpCard
                initialSetting={{
                    ...paid,
                    enabled: true,
                    source: "clone_fallback",
                }}
            />,
        );
        expect(
            screen.getByText(/refused a clone from the shared network/),
        ).toBeInTheDocument();
    });
});
