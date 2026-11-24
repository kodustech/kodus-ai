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
const mockRefresh = jest.fn();
jest.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: mockRefresh }),
}));
const mockAccess = { canEdit: true };
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => mockAccess.canEdit,
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
        mockAccess.canEdit = true;
    });

    it("is not shown where sandboxes never leave through Kodus's network", () => {
        const { container } = render(
            <FixedEgressIpCard
                teamId="team-1"
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
        render(
            <FixedEgressIpCard
                teamId="team-1"
                initialSetting={none}
                loadFailed
            />,
        );
        expect(screen.getByText("Fixed outbound IP")).toBeInTheDocument();
        expect(
            screen.getByText(/could not load this setting/i),
        ).toBeInTheDocument();
        expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    });

    it("is never shown on a self-hosted install, whether its read worked or failed", () => {
        mockDeployment.selfHosted = true;
        for (const loadFailed of [false, true]) {
            const { container, unmount } = render(
                <FixedEgressIpCard
                    teamId="team-1"
                    initialSetting={paid}
                    loadFailed={loadFailed}
                />,
            );
            expect(container).toBeEmptyDOMElement();
            unmount();
        }
    });

    it("says the plan could not be confirmed and cannot be turned on, without the plans link", () => {
        render(
            <FixedEgressIpCard
                teamId="team-1"
                initialSetting={{ ...paid, planUnconfirmed: true }}
            />,
        );
        expect(
            screen.getByText(/could not confirm your plan/i),
        ).toBeInTheDocument();
        expect(screen.getByRole("switch")).toBeDisabled();
        expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("still lets a team turn it off while the plan cannot be confirmed", () => {
        render(
            <FixedEgressIpCard
                teamId="team-1"
                initialSetting={{
                    ...paid,
                    enabled: true,
                    planUnconfirmed: true,
                }}
            />,
        );
        expect(screen.getByRole("switch")).toBeEnabled();
        expect(
            screen.queryByText(/could not confirm your plan/i),
        ).not.toBeInTheDocument();
        expect(screen.getByText("203.0.113.10")).toBeInTheDocument();
    });

    it("cannot be turned on from a plan without it, and points to the plans", () => {
        render(
            <FixedEgressIpCard
                teamId="team-1"
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
        render(<FixedEgressIpCard teamId="team-1" initialSetting={paid} />);

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
        render(<FixedEgressIpCard teamId="team-1" initialSetting={paid} />);

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
                teamId="team-1"
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

    it("writes to the team the page read, the one it was given", async () => {
        setMock.mockResolvedValue({ ...paid, enabled: true });
        render(
            <FixedEgressIpCard teamId="team-of-page" initialSetting={paid} />,
        );
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() =>
            expect(setMock).toHaveBeenCalledWith({
                teamId: "team-of-page",
                enabled: true,
            }),
        );
    });

    it("re-reads the page after a change and says when new reviews stop using it", async () => {
        setMock.mockResolvedValue({ ...paid, enabled: false });
        render(
            <FixedEgressIpCard
                teamId="team-1"
                initialSetting={{ ...paid, enabled: true, savedOn: true }}
            />,
        );
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "success",
                description:
                    "New reviews stop using it within about 10 minutes.",
            }),
        );
    });

    it("sends one change while one is saving", async () => {
        let resolve!: (v: typeof paid) => void;
        setMock.mockReturnValue(
            new Promise((_resolve) => (resolve = _resolve)) as never,
        );
        render(<FixedEgressIpCard teamId="team-1" initialSetting={paid} />);
        fireEvent.click(screen.getByRole("switch"));
        fireEvent.click(screen.getByRole("switch"));
        expect(setMock).toHaveBeenCalledTimes(1);
        resolve({ ...paid, enabled: true });
        await waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    });

    it("cannot be changed by someone who is not an owner, and says so", () => {
        mockAccess.canEdit = false;
        render(<FixedEgressIpCard teamId="team-1" initialSetting={paid} />);
        expect(screen.getByRole("switch")).toBeDisabled();
        expect(
            screen.getByText("Only an organization owner can change this."),
        ).toBeInTheDocument();
    });

    it("shows a downgraded team its stored choice and lets it turn it off", async () => {
        setMock.mockResolvedValue({
            ...paid,
            allowedByPlan: false,
            enabled: false,
            savedOn: false,
        });
        render(
            <FixedEgressIpCard
                teamId="team-1"
                initialSetting={{
                    ...paid,
                    allowedByPlan: false,
                    enabled: false,
                    savedOn: true,
                }}
            />,
        );
        const toggle = screen.getByRole("switch");
        expect(toggle).toHaveAttribute("aria-checked", "true");
        expect(toggle).toBeEnabled();
        expect(
            screen.getByText(
                /Your plan does not include the fixed outbound IP/,
            ),
        ).toBeInTheDocument();
        fireEvent.click(toggle);
        await waitFor(() =>
            expect(setMock).toHaveBeenCalledWith({
                teamId: "team-1",
                enabled: false,
            }),
        );
    });

    it("keeps the saved state when the re-read right after a change fails", async () => {
        setMock.mockResolvedValue({ ...paid, enabled: true });
        const { rerender } = render(
            <FixedEgressIpCard teamId="team-1" initialSetting={paid} />,
        );
        fireEvent.click(screen.getByRole("switch"));
        await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
        rerender(
            <FixedEgressIpCard
                teamId="team-1"
                initialSetting={{
                    available: false,
                    allowedByPlan: false,
                    enabled: false,
                }}
                loadFailed
            />,
        );
        expect(screen.queryByText(/could not load this setting/i)).toBeNull();
        expect(screen.getByRole("switch")).toHaveAttribute(
            "aria-checked",
            "true",
        );
    });
});
