/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { useRevokeRuntimeCell } from "@services/runtime/queries";
import { fireEvent, render, screen } from "@testing-library/react";

import { ConnectCell, RevokeCell } from "./cell-actions";

jest.mock("@services/runtime/queries", () => ({
    useRevokeRuntimeCell: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const revoke = jest.fn();
beforeEach(() => {
    revoke.mockReset();
    (useRevokeRuntimeCell as jest.Mock).mockReturnValue({
        mutate: revoke,
        isPending: false,
    });
});

describe("ConnectCell", () => {
    it("sends the owner to Settings → Cells to connect one", () => {
        render(<ConnectCell />);
        expect(
            screen.getByRole("link", { name: "Connect a host" }),
        ).toHaveAttribute("href", "/runtime/settings/cells");
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });
});

describe("RevokeCell", () => {
    it("revokes a customer cell after confirming, and offers nothing for the managed or a revoked one", () => {
        const { rerender } = render(
            <RevokeCell
                cell={{
                    cellId: "kodus-cloud",
                    owner: "kodus",
                    status: "connected",
                }}
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Revoke" }),
        ).not.toBeInTheDocument();
        rerender(
            <RevokeCell
                cell={{
                    cellId: "cell-9",
                    owner: "customer",
                    status: "revoked",
                }}
            />,
        );
        expect(
            screen.queryByRole("button", { name: "Revoke" }),
        ).not.toBeInTheDocument();

        rerender(
            <RevokeCell
                cell={{
                    cellId: "cell-9",
                    owner: "customer",
                    status: "connected",
                }}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
        expect(revoke).not.toHaveBeenCalled();
        const confirm = screen
            .getAllByRole("button", { name: "Revoke" })
            .at(-1)!;
        fireEvent.click(confirm);
        expect(revoke).toHaveBeenCalledWith(
            { cellId: "cell-9" },
            expect.anything(),
        );
    });
});
