/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { toast } from "@components/ui/toaster/use-toast";
import { useUpdateEnvironmentSettings } from "@services/runtime/queries";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MachineSizeSetting } from "./machine-size";

jest.mock("@services/runtime/queries", () => ({
    useUpdateEnvironmentSettings: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

// Radix's radio group measures its items.
beforeAll(() => {
    global.ResizeObserver = class {
        observe = jest.fn();
        unobserve = jest.fn();
        disconnect = jest.fn();
    };
});

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (toast as jest.Mock).mockReset();
    (useUpdateEnvironmentSettings as jest.Mock).mockReturnValue({
        mutate,
        isPending: false,
    });
});

describe("MachineSizeSetting", () => {
    it("starts on the saved size, says what setups boot at, with nothing to save", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting={null}
                hasSetup
                canEdit
            />,
        );
        expect(
            screen.getByRole("radio", { name: /Host default/ }),
        ).toBeChecked();
        expect(screen.getByText(/Setups boot at/).textContent).toBe(
            "Setups boot at the host default.",
        );
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        expect(screen.queryByText(/Set it up again/)).not.toBeInTheDocument();
    });

    it("says what the first setup boots at before any setup ran", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting="medium"
                hasSetup={false}
                canEdit
            />,
        );
        expect(screen.getByText(/The first setup boots at/).textContent).toBe(
            "The first setup boots at Medium · 8 GB · 4 CPUs.",
        );
    });

    it("offers the presets with their memory and CPUs, and hints that heavy compiled builds need more", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                hasSetup={false}
                canEdit
            />,
        );
        expect(
            screen.getByRole("radio", { name: /Small · 4 GB · 2 CPUs/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("radio", { name: /Medium · 8 GB · 4 CPUs/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("radio", { name: /Large · 16 GB · 8 CPUs/ }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/heavy compiled\s+builds need Medium or Large/),
        ).toBeInTheDocument();
        expect(screen.queryByText(/gvisor-mem-max/)).not.toBeInTheDocument();
    });

    it("names the cell's own ceiling on a cell in the org's cloud", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                hasSetup={false}
                canEdit
                selfHosted
            />,
        );
        expect(screen.getByText("-gvisor-mem-max")).toBeInTheDocument();
        expect(screen.getByText("-gvisor-cpus-max")).toBeInTheDocument();
    });

    it("locks the choice and shows progress while it saves", () => {
        (useUpdateEnvironmentSettings as jest.Mock).mockReturnValue({
            mutate,
            isPending: true,
        });
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting={null}
                hasSetup
                canEdit
            />,
        );
        for (const radio of screen.getAllByRole("radio"))
            expect(radio).toBeDisabled();
        expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled();
    });

    it("toasts the error when the save fails", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting={null}
                hasSetup
                canEdit
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: /^Medium/ }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        act(() => mutate.mock.calls[0][1].onError(new Error("boom")));
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "danger",
                title: "Couldn't save the machine size",
            }),
        );
    });

    it("saves the chosen preset, and null to go back to the cell default", () => {
        const { unmount } = render(
            <MachineSizeSetting
                environmentId="env-1"
                setting={null}
                hasSetup
                canEdit
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: /^Large/ }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(mutate).toHaveBeenCalledWith(
            { environmentId: "env-1", machineSize: "large" },
            expect.anything(),
        );
        unmount();
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting="large"
                bootedAt={{ memoryMb: 16_384, cpus: 8 }}
                hasSetup
                canEdit
            />,
        );
        fireEvent.click(screen.getByRole("radio", { name: /Host default/ }));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(mutate).toHaveBeenLastCalledWith(
            { environmentId: "env-1", machineSize: null },
            expect.anything(),
        );
    });

    it("says when the last setup booted at another size, with the way to set it up again", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting="large"
                hasSetup
                canEdit
                setupAction={<button type="button">Set up again</button>}
            />,
        );
        expect(screen.getByText(/The last setup booted at/).textContent).toBe(
            "The last setup booted at the host default. The next one boots at Large · 16 GB · 8 CPUs.",
        );
        expect(
            screen.getByText("Set it up again to boot at the saved size."),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Set up again" }),
        ).toBeInTheDocument();
    });

    it("is read-only for anyone but the org owner, and says so", () => {
        render(
            <MachineSizeSetting
                environmentId="env-1"
                setting="medium"
                hasSetup={false}
                canEdit={false}
            />,
        );
        for (const radio of screen.getAllByRole("radio"))
            expect(radio).toBeDisabled();
        expect(
            screen.getByText(
                /Only the owner of the organization can change it/,
            ),
        ).toBeInTheDocument();
    });
});
