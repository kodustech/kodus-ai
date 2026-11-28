/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    useCellRegistrationTokens,
    useCreateCellRegistrationToken,
    useRevokeCellRegistrationToken,
} from "@services/runtime/queries";
import { fireEvent, render, screen } from "@testing-library/react";

import { ConnectCell } from "./connect-cell";
import { RegistrationTokens } from "./registration-tokens";

jest.mock("@services/runtime/queries", () => ({
    useCreateCellRegistrationToken: jest.fn(),
    useCellRegistrationTokens: jest.fn(),
    useRevokeCellRegistrationToken: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const TOKEN = "kcr_synthetic-token-for-the-screen";
const create = jest.fn();
const revoke = jest.fn();
beforeEach(() => {
    create.mockReset();
    revoke.mockReset();
    (useCreateCellRegistrationToken as jest.Mock).mockReturnValue({
        mutate: create,
        isPending: false,
    });
    (useRevokeCellRegistrationToken as jest.Mock).mockReturnValue({
        mutate: revoke,
        isPending: false,
    });
});

describe("Connect a cell", () => {
    it("makes a token for the default place, shows it once, and the commands do not contain it", () => {
        create.mockImplementation((_topology, { onSuccess }) =>
            onSuccess({
                id: "a".repeat(64),
                token: TOKEN,
                topology: "self_hosted",
                expiresAt: "2026-11-12T12:15:00.000Z",
            }),
        );
        render(<ConnectCell defaultTopology="self_hosted" />);
        fireEvent.click(
            screen.getByRole("button", { name: "Create registration token" }),
        );
        expect(create).toHaveBeenCalledWith("self_hosted", expect.anything());

        expect(screen.getByLabelText("Registration token")).toHaveTextContent(
            TOKEN,
        );
        const commands = screen.getByLabelText("Registration commands");
        expect(commands).toHaveTextContent(
            "cell-host.sh install --profile docker-gvisor --bundle ./cell-host",
        );
        expect(commands).not.toHaveTextContent(TOKEN);

        // Done forgets it: nothing on the page shows it again.
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Create registration token" }),
        ).toBeInTheDocument();
    });
});

describe("Registration tokens", () => {
    const row = (id: string, state: string) => ({
        id: id.repeat(64),
        topology: "self_hosted",
        issuedBy: "u-1",
        issuedAt: "2026-11-12T12:00:00.000Z",
        expiresAt: "2026-11-12T12:15:00.000Z",
        state,
    });

    it("a pending token is revoked after confirming; a used one offers no revoke", () => {
        (useCellRegistrationTokens as jest.Mock).mockReturnValue({
            data: [row("a", "pending"), row("b", "used")],
            isLoading: false,
            isError: false,
        });
        render(<RegistrationTokens currentUserId="u-1" />);
        expect(screen.getByText("Waiting for a host")).toBeInTheDocument();
        expect(screen.getByText("Used")).toBeInTheDocument();
        expect(screen.getAllByText("You")).toHaveLength(2);

        const buttons = screen.getAllByRole("button", { name: "Revoke" });
        expect(buttons).toHaveLength(1);
        fireEvent.click(buttons[0]);
        expect(revoke).not.toHaveBeenCalled();
        fireEvent.click(
            screen.getAllByRole("button", { name: "Revoke" }).at(-1)!,
        );
        expect(revoke).toHaveBeenCalledWith("a".repeat(64), expect.anything());
    });

    it("says so when no token was made in the last 24 hours", () => {
        (useCellRegistrationTokens as jest.Mock).mockReturnValue({
            data: [],
            isLoading: false,
            isError: false,
        });
        render(<RegistrationTokens />);
        expect(
            screen.getByText("No registration token in the last 24 hours."),
        ).toBeInTheDocument();
    });
});
