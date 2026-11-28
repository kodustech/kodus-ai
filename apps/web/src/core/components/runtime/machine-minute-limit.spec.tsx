/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { RuntimeMachineMinutesToday } from "@services/runtime/contracts";
import { useUpdateRuntimeMachineMinutes } from "@services/runtime/queries";
import { fireEvent, render, screen } from "@testing-library/react";

import { MachineMinuteLimit } from "./machine-minute-limit";

jest.mock("@services/runtime/queries", () => ({
    useUpdateRuntimeMachineMinutes: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useUpdateRuntimeMachineMinutes as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const today = (
    patch: Partial<RuntimeMachineMinutesToday> = {},
): RuntimeMachineMinutesToday => ({
    limitMinutes: 1000,
    deploymentLimitMinutes: 1000,
    orgLimitMinutes: null,
    limitSource: "deployment",
    committedMinutes: 40,
    usedMinutes: 30,
    openRounds: 0,
    remainingMinutes: 960,
    resetsAt: "2026-11-17T00:00:00.000Z",
    ...patch,
});

const field = () =>
    screen.getByLabelText("Your organization's machine minutes per day");
const save = () => screen.getByRole("button", { name: "Save" });

describe("the org's own daily machine-minute limit", () => {
    it("says which limit holds the org and what happens when the day's minutes run out", () => {
        render(<MachineMinuteLimit today={today()} canEdit />);
        expect(
            screen.getByText(
                /The deployment's limit of 1,000 min a day applies/,
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/refuses new setups and Runs with a blocker/),
        ).toBeInTheDocument();
        expect(field()).toHaveAttribute(
            "placeholder",
            "1,000 (the deployment's)",
        );
    });

    it("saves a whole number of minutes below the deployment's", () => {
        render(<MachineMinuteLimit today={today()} canEdit />);
        fireEvent.change(field(), { target: { value: "600" } });
        fireEvent.click(save());
        expect(mutate).toHaveBeenCalledWith(
            { minutesPerDay: 600 },
            expect.anything(),
        );
    });

    it("refuses more than the deployment allows and says why", () => {
        render(<MachineMinuteLimit today={today()} canEdit />);
        fireEvent.change(field(), { target: { value: "1500" } });
        expect(screen.getByRole("alert")).toHaveTextContent(
            "This deployment allows up to 1,000 min a day; your organization's limit can only lower it.",
        );
        expect(save()).toBeDisabled();
        fireEvent.submit(save().closest("form")!);
        expect(mutate).not.toHaveBeenCalled();
    });

    it("removes the org's own limit, going back to the deployment's", () => {
        render(
            <MachineMinuteLimit
                today={today({
                    limitMinutes: 300,
                    orgLimitMinutes: 300,
                    limitSource: "org",
                })}
                canEdit
            />,
        );
        expect(field()).toHaveValue(300);
        fireEvent.click(screen.getByRole("button", { name: "Remove limit" }));
        expect(mutate).toHaveBeenCalledWith(
            { minutesPerDay: null },
            expect.anything(),
        );
    });

    it("offers no removal while the org has no limit of its own", () => {
        render(<MachineMinuteLimit today={today()} canEdit />);
        expect(
            screen.queryByRole("button", { name: "Remove limit" }),
        ).not.toBeInTheDocument();
    });

    it("is read-only for members who cannot edit the organization's settings", () => {
        render(
            <MachineMinuteLimit
                today={today({
                    limitMinutes: 300,
                    orgLimitMinutes: 300,
                    limitSource: "org",
                })}
                canEdit={false}
            />,
        );
        expect(field()).toBeDisabled();
        expect(save()).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Remove limit" }),
        ).toBeDisabled();
        expect(
            screen.getByText("Only organization admins can change this limit."),
        ).toBeInTheDocument();
    });
});
