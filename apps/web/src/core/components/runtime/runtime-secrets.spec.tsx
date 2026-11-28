/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    useCreateRuntimeSecret,
    useDeleteRuntimeSecret,
    useRuntimeSecrets,
    useUpdateRuntimeSecret,
} from "@services/runtime/secrets";
import { fireEvent, render, screen } from "@testing-library/react";

import { RuntimeSecretsSection } from "./runtime-secrets";

jest.mock("@services/runtime/secrets", () => ({
    useRuntimeSecrets: jest.fn(),
    useCreateRuntimeSecret: jest.fn(),
    useUpdateRuntimeSecret: jest.fn(),
    useDeleteRuntimeSecret: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

// Synthetic values only.
const VALUE = "npm_synthetic_value_7f3a91c2d4";
const npm = {
    secretId: "npm_token",
    name: "NPM_TOKEN",
    hosts: ["npm.corp.example"],
    createdBy: { userId: "u-1", email: "owner@example.test" },
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedBy: { userId: "u-1", email: "owner@example.test" },
    updatedAt: "2026-11-12T10:00:00.000Z",
    valueSetAt: "2026-11-12T10:00:00.000Z",
};
const create = jest.fn();
const update = jest.fn();
const remove = jest.fn();

const listing = (data: unknown) =>
    (useRuntimeSecrets as jest.Mock).mockReturnValue({ data, isLoading: false, isError: false });

beforeEach(() => {
    [create, update, remove].forEach((m) => m.mockReset());
    (useCreateRuntimeSecret as jest.Mock).mockReturnValue({ mutate: create, isPending: false });
    (useUpdateRuntimeSecret as jest.Mock).mockReturnValue({ mutate: update, isPending: false });
    (useDeleteRuntimeSecret as jest.Mock).mockReturnValue({ mutate: remove, isPending: false });
});

describe("RuntimeSecretsSection", () => {
    it("offers nothing to add when this Kodus has no secret store, and says so", () => {
        listing({ configured: false, secrets: [] });
        render(<RuntimeSecretsSection />);
        expect(screen.queryByRole("button", { name: "Add secret" })).not.toBeInTheDocument();
        expect(screen.getByText(/has no secret store yet/)).toBeInTheDocument();
    });

    it("sends a new secret's name, hosts and value once they are valid", () => {
        listing({ configured: true, secrets: [] });
        render(<RuntimeSecretsSection />);
        fireEvent.click(screen.getByRole("button", { name: "Add secret" }));
        expect(screen.getByText(/never enters Kody's machine/)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Name"), { target: { value: "npm_token" } });
        fireEvent.change(screen.getByLabelText("Allowed hosts"), { target: { value: "*.corp.example" } });
        fireEvent.change(screen.getByLabelText("Value"), { target: { value: VALUE } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(create).not.toHaveBeenCalled();
        expect(screen.getByRole("alert")).toHaveTextContent("without a wildcard");

        fireEvent.change(screen.getByLabelText("Allowed hosts"), { target: { value: "NPM.corp.example\nnpm.corp.example" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(create).toHaveBeenCalledWith({ name: "NPM_TOKEN", hosts: ["npm.corp.example"], value: VALUE }, expect.anything());
    });

    it("changes the hosts without asking for the value, and replaces the value without the hosts", () => {
        listing({ configured: true, secrets: [npm] });
        render(<RuntimeSecretsSection />);
        fireEvent.click(screen.getByRole("button", { name: "Hosts" }));
        expect(screen.queryByLabelText("Value")).not.toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Allowed hosts"), { target: { value: "npm2.corp.example" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(update).toHaveBeenCalledWith({ secretId: "npm_token", hosts: ["npm2.corp.example"] }, expect.anything());

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        fireEvent.click(screen.getByRole("button", { name: "Replace value" }));
        expect(screen.queryByLabelText("Allowed hosts")).not.toBeInTheDocument();
        expect(screen.getByLabelText("New value")).toHaveValue("");
        fireEvent.change(screen.getByLabelText("New value"), { target: { value: VALUE } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(update).toHaveBeenLastCalledWith({ secretId: "npm_token", value: VALUE }, expect.anything());
    });

    it("deletes a secret only after the confirmation", () => {
        listing({ configured: true, secrets: [npm] });
        render(<RuntimeSecretsSection />);
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        expect(remove).not.toHaveBeenCalled();
        fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
        expect(remove).toHaveBeenCalledWith("npm_token", expect.anything());
    });
});
