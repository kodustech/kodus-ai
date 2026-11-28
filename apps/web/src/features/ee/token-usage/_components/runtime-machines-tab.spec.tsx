/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { usePermission } from "@services/permissions/hooks";
import type { RuntimeMachineMinutesToday } from "@services/runtime/contracts";
import {
    useRuntimeMachineMinutes,
    useUpdateRuntimeMachineMinutes,
} from "@services/runtime/queries";
import { render, screen, within } from "@testing-library/react";

import { RuntimeMachinesTab } from "./runtime-machines-tab";

jest.mock("@services/permissions/hooks", () => ({ usePermission: jest.fn() }));
jest.mock("@services/runtime/queries", () => ({
    useRuntimeMachineMinutes: jest.fn(),
    useUpdateRuntimeMachineMinutes: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("@components/runtime/usage-report", () => ({
    RuntimeUsageContent: () => <div>month usage</div>,
}));

const today: RuntimeMachineMinutesToday = {
    limitMinutes: 10_000,
    deploymentLimitMinutes: 10_000,
    orgLimitMinutes: null,
    limitSource: "deployment",
    committedMinutes: 40,
    usedMinutes: 30,
    openRounds: 0,
    remainingMinutes: 9_960,
    resetsAt: "2026-11-17T00:00:00.000Z",
};

beforeEach(() => {
    (useRuntimeMachineMinutes as jest.Mock).mockReturnValue({
        data: today,
        isLoading: false,
        isError: false,
    });
    (useUpdateRuntimeMachineMinutes as jest.Mock).mockReturnValue({
        mutate: jest.fn(),
        isPending: false,
    });
});

describe("the Runtime machines tab", () => {
    it("shows today's meter and the daily-limit form, then the month's usage", () => {
        (usePermission as jest.Mock).mockReturnValue(true);
        render(<RuntimeMachinesTab />);

        const card = screen.getByRole("region", { name: "Today" });
        expect(
            within(card).getByText(/of 10,000 min used/),
        ).toBeInTheDocument();
        expect(
            within(card).getByText(/Resets at 00:00 UTC/),
        ).toBeInTheDocument();
        expect(
            within(card).getByLabelText(
                "Your organization's machine minutes per day",
            ),
        ).toBeEnabled();
        expect(screen.getByText("month usage")).toBeInTheDocument();
    });

    it("lets only whoever may update the organization's settings change the limit", () => {
        (usePermission as jest.Mock).mockReturnValue(false);
        render(<RuntimeMachinesTab />);

        expect(
            screen.getByLabelText(
                "Your organization's machine minutes per day",
            ),
        ).toBeDisabled();
        expect(usePermission).toHaveBeenCalledWith(
            "update",
            "organization_settings",
        );
    });
});
