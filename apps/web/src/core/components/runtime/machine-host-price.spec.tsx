/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useUpdateRuntimeOrgSettings } from "@services/runtime/queries";
import { fireEvent, render, screen } from "@testing-library/react";

import { MachineHostPrice } from "./machine-host-price";

jest.mock("@services/runtime/queries", () => ({
    useUpdateRuntimeOrgSettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useUpdateRuntimeOrgSettings as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

const field = () => screen.getByLabelText("Price per host-hour, in US$");
const save = () => screen.getByRole("button", { name: "Save" });

describe("the org's price per host-hour field", () => {
    it("says the org's own hosts are not priced until a price is set, and how a price is used", () => {
        render(<MachineHostPrice value={null} canEdit />);
        expect(field()).toHaveValue(null);
        expect(
            screen.getByText(
                "Not set: machine time on your own hosts is not priced.",
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/by the share of the host its machines held/),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Remove the price" }),
        ).not.toBeInTheDocument();
    });

    it("saves a price above $0", () => {
        render(<MachineHostPrice value={null} canEdit />);
        fireEvent.change(field(), { target: { value: "0.1344" } });
        fireEvent.click(save());
        expect(mutate).toHaveBeenCalledWith(
            { machineUsdPerHostHour: 0.1344 },
            expect.anything(),
        );
    });

    it("refuses a price outside $0 to $1,000 and says why", () => {
        render(<MachineHostPrice value={null} canEdit />);
        fireEvent.change(field(), { target: { value: "0" } });
        expect(screen.getByRole("alert")).toHaveTextContent(
            "Enter a price above $0 and at most $1,000.",
        );
        expect(save()).toBeDisabled();
        fireEvent.submit(save().closest("form")!);
        expect(mutate).not.toHaveBeenCalled();
    });

    it("removes the price", () => {
        render(<MachineHostPrice value={0.5} canEdit />);
        expect(field()).toHaveValue(0.5);
        fireEvent.click(screen.getByRole("button", { name: "Remove the price" }));
        expect(mutate).toHaveBeenCalledWith(
            { machineUsdPerHostHour: null },
            expect.anything(),
        );
    });

    it("is read-only for members who cannot edit the organization's settings", () => {
        render(<MachineHostPrice value={0.5} canEdit={false} />);
        expect(field()).toBeDisabled();
        expect(save()).toBeDisabled();
        expect(
            screen.getByRole("button", { name: "Remove the price" }),
        ).toBeDisabled();
        expect(
            screen.getByText("Only organization admins can change this."),
        ).toBeInTheDocument();
    });
});
