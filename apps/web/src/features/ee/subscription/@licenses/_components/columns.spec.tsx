/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { columns, type LicenseTableRow } from "./columns";

const mockSubscription = {
    status: "licensed-self-hosted",
    numberOfLicenses: 1,
    usersWithAssignedLicense: [{ git_id: "1" }],
};
const mockAssign = jest.fn();
const mockShowModal = jest.fn();
const mockToast = jest.fn();

jest.mock(
    "src/features/ee/subscription/_hooks/use-subscription-status",
    () => ({ useSubscriptionStatus: () => mockSubscription }),
);
jest.mock("src/core/providers/selected-team-context", () => ({
    useSelectedTeamId: () => ({ teamId: "team-1" }),
}));
jest.mock("@services/setup/hooks", () => ({
    useSuspenseGetConnections: () => [
        { category: "CODE_MANAGEMENT", platformName: "GITHUB" },
    ],
}));
jest.mock("@services/permissions/hooks", () => ({
    usePermission: () => true,
}));
jest.mock("../../_actions/assign-or-deassign-license", () => ({
    assignOrDeassignUserLicenseAction: (...args: unknown[]) =>
        mockAssign(...args),
}));
jest.mock("@components/ui/magic-modal", () => ({
    magicModal: {
        show: (...args: unknown[]) => mockShowModal(...args),
        hide: jest.fn(),
    },
}));
jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: (...args: unknown[]) => mockToast(...args),
}));
jest.mock("./no-more-licenses-modal", () => ({
    NoMoreLicensesModal: () => null,
}));
jest.mock("src/core/components/async-boundary", () => ({
    AsyncBoundary: ({ children }: { children: ReactNode }) => children,
}));

const renderSeat = (row: Partial<LicenseTableRow>) => {
    const original: LicenseTableRow = {
        id: 2,
        name: "dev",
        licenseStatus: "inactive",
        ...row,
    };
    const cell = columns[1].cell as (ctx: unknown) => ReactNode;
    render(<>{cell({ row: { original } })}</>);
    return screen.getByRole("switch");
};

describe("License assignment switch", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSubscription.status = "licensed-self-hosted";
        mockSubscription.numberOfLicenses = 1;
        mockSubscription.usersWithAssignedLicense = [{ git_id: "1" }];
        mockAssign.mockResolvedValue({ failures: [], successful: [] });
    });

    it("explains that every seat is taken instead of asking the server", () => {
        fireEvent.click(renderSeat({ licenseStatus: "inactive" }));

        expect(mockShowModal).toHaveBeenCalledTimes(1);
        expect(mockAssign).not.toHaveBeenCalled();
    });

    it("assigns a seat while one is free", async () => {
        mockSubscription.numberOfLicenses = 2;

        fireEvent.click(renderSeat({ licenseStatus: "inactive" }));

        await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
        expect(mockAssign.mock.calls[0][0].user).toEqual({
            git_id: "2",
            git_tool: "github",
            licenseStatus: "active",
        });
        expect(mockShowModal).not.toHaveBeenCalled();
    });

    it("still releases a seat when every seat is taken", async () => {
        fireEvent.click(renderSeat({ id: 1, licenseStatus: "active" }));

        await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
        expect(mockAssign.mock.calls[0][0].user.licenseStatus).toBe("inactive");
        expect(mockShowModal).not.toHaveBeenCalled();
    });

    it("says so when the server refuses the seat", async () => {
        mockSubscription.numberOfLicenses = 2;
        mockAssign.mockResolvedValue({
            failures: [{ error: "No licenses available" }],
            successful: [],
        });

        fireEvent.click(renderSeat({ licenseStatus: "inactive" }));

        await waitFor(() => expect(mockToast).toHaveBeenCalledTimes(1));
        expect(mockToast).toHaveBeenCalledWith({
            variant: "danger",
            title: "Could not assign a seat to dev",
            description: "No licenses available",
        });
    });

    it("stays quiet when the seat is granted", async () => {
        mockSubscription.numberOfLicenses = 2;

        fireEvent.click(renderSeat({ licenseStatus: "inactive" }));

        await waitFor(() => expect(mockAssign).toHaveBeenCalledTimes(1));
        expect(mockToast).not.toHaveBeenCalled();
    });

    it("is off limits without a license", () => {
        mockSubscription.status = "self-hosted";

        expect(renderSeat({ licenseStatus: "inactive" })).toBeDisabled();
    });
});
