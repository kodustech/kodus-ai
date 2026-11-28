/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { SandboxCapacityView } from "@services/runtime/contracts";
import {
    capacityWarning,
    formatWait,
    parseMaxConcurrent,
} from "@services/runtime/model/sandbox-capacity";
import { useSandboxCapacity, useUpdateSandboxCapacity } from "@services/runtime/queries";
import { fireEvent, render, screen } from "@testing-library/react";

import { SandboxCapacityForm, SandboxCapacitySection } from "./sandbox-capacity";

jest.mock("@services/runtime/queries", () => ({
    useSandboxCapacity: jest.fn(),
    useUpdateSandboxCapacity: jest.fn(),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));

const view = (over: Partial<SandboxCapacityView> = {}): SandboxCapacityView => ({
    settings: { maxConcurrent: 5, maxWaitMs: 600_000 },
    saved: true,
    live: { inUse: 4, cap: 5, queued: 2, oldestWaitMs: 72_000 },
    suggestedMaxConcurrent: 5,
    cell: { allocatableMemoryMb: 22_528, sandboxMemoryMb: 2048, sandboxCpus: 2, poolReady: 0 },
    cellUnavailableReason: null,
    ...over,
});

// Radix Switch measures its box; jsdom has no ResizeObserver.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const mutate = jest.fn();
beforeEach(() => {
    mutate.mockReset();
    (useUpdateSandboxCapacity as jest.Mock).mockReturnValue({ mutate, isPending: false });
});

describe("capacity model", () => {
    it("formats the wait", () => {
        expect(formatWait(72_000)).toBe("1m12s");
        expect(formatWait(45_000)).toBe("45s");
        expect(formatWait(0)).toBe("0s");
    });
    it("parses the cap: empty is no limit, else 1..100", () => {
        expect(parseMaxConcurrent("")).toEqual({ ok: true, value: null });
        expect(parseMaxConcurrent("7")).toEqual({ ok: true, value: 7 });
        for (const bad of ["0", "101", "2.5", "abc"]) expect(parseMaxConcurrent(bad).ok).toBe(false);
    });
    it("warns when the cap does not fit the cell, or leaves no room for a 12 GB Run", () => {
        const cell = view().cell;
        expect(capacityWarning(5, cell)).toBeNull(); // 10240 used, 12288 free
        expect(capacityWarning(6, cell)).toMatch(/12 GB Run/); // 12288 used, 10240 free
        expect(capacityWarning(12, cell)).toMatch(/more than the 22528 MB/);
        expect(capacityWarning(null, cell)).toBeNull();
        expect(capacityWarning(50, null)).toBeNull();
    });
});

describe("SandboxCapacityForm", () => {
    it("shows the live numbers, the size and the pool", () => {
        render(<SandboxCapacityForm view={view()} />);
        expect(screen.getByText("4 of 5")).toBeInTheDocument();
        expect(screen.getByText("2")).toBeInTheDocument();
        expect(screen.getByText("1m12s")).toBeInTheDocument();
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "4");
        expect(screen.getByText("2 GB · 2 CPU")).toBeInTheDocument();
        expect(screen.getByText(/Suggested: 5/)).toBeInTheDocument();
    });

    it("shows the warm pool as ready of target, and unknown when an older cell reports none", () => {
        const { unmount } = render(
            <SandboxCapacityForm view={view({ cell: { allocatableMemoryMb: 22_528, sandboxMemoryMb: 2048, sandboxCpus: 2, poolReady: 3, poolTarget: 6 } })} />,
        );
        expect(screen.getByText("3 of 6")).toBeInTheDocument();
        unmount();
        render(<SandboxCapacityForm view={view({ cell: { allocatableMemoryMb: 22_528, sandboxMemoryMb: 2048, sandboxCpus: 2, poolReady: null } })} />);
        expect(screen.getByText("unknown")).toBeInTheDocument();
    });

    it("says no limit when no cap is set and does not draw a bar", () => {
        render(
            <SandboxCapacityForm
                view={view({
                    settings: { maxConcurrent: null, maxWaitMs: 600_000 },
                    live: { inUse: null, cap: 0, queued: 0, oldestWaitMs: 0 },
                })}
            />,
        );
        expect(screen.getByText("No limit set")).toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).toBeNull();
        expect(screen.queryByLabelText("Maximum at the same time")).toBeNull();
        expect(screen.getByRole("switch")).not.toBeChecked();
    });

    it("says why there is no suggestion when the cell is unknown", () => {
        render(
            <SandboxCapacityForm
                view={view({ cell: null, suggestedMaxConcurrent: null, cellUnavailableReason: "cell_facts_not_exposed_by_hub" })}
            />,
        );
        expect(screen.getByText(/No suggestion/)).toBeInTheDocument();
        expect(screen.getAllByText("unknown")).toHaveLength(2);
    });

    it("warns while editing and saves the edited cap", () => {
        render(<SandboxCapacityForm view={view()} />);
        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();
        fireEvent.change(screen.getByLabelText("Maximum at the same time"), { target: { value: "6" } });
        expect(screen.getByRole("alert")).toHaveTextContent(/12 GB Run/);
        fireEvent.click(save);
        expect(mutate).toHaveBeenCalledWith(
            { maxConcurrent: 6, maxWaitMs: 600_000 },
            expect.any(Object),
        );
    });

    it("saves no limit as null when the switch is turned off", () => {
        render(<SandboxCapacityForm view={view()} />);
        fireEvent.click(screen.getByRole("switch"));
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(mutate).toHaveBeenCalledWith({ maxConcurrent: null, maxWaitMs: 600_000 }, expect.any(Object));
    });

    it("shows the unsaved state, Discard restores it", () => {
        render(<SandboxCapacityForm view={view()} />);
        fireEvent.change(screen.getByLabelText("Maximum at the same time"), { target: { value: "4" } });
        expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        expect(screen.getByLabelText("Maximum at the same time")).toHaveValue(5);
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });

    it("refuses an empty cap while the limit is on", () => {
        render(<SandboxCapacityForm view={view()} />);
        fireEvent.change(screen.getByLabelText("Maximum at the same time"), { target: { value: "" } });
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        expect(screen.getByRole("alert")).toHaveTextContent(/turn the limit off/);
    });

    it("refuses an invalid cap", () => {
        render(<SandboxCapacityForm view={view()} />);
        fireEvent.change(screen.getByLabelText("Maximum at the same time"), { target: { value: "101" } });
        expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
        expect(screen.getByRole("alert")).toHaveTextContent(/1 to 100/);
    });
});

describe("SandboxCapacitySection states", () => {
    it("loading", () => {
        (useSandboxCapacity as jest.Mock).mockReturnValue({ isLoading: true });
        render(<SandboxCapacitySection />);
        expect(screen.getByRole("heading", { name: "Sandboxes" })).toBeInTheDocument();
        expect(screen.queryByText("Save")).toBeNull();
    });
    it("error", () => {
        (useSandboxCapacity as jest.Mock).mockReturnValue({ isLoading: false, isError: true });
        render(<SandboxCapacitySection />);
        expect(screen.getByText(/not available right now/)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });
    it("ready", () => {
        (useSandboxCapacity as jest.Mock).mockReturnValue({ isLoading: false, isError: false, data: view() });
        render(<SandboxCapacitySection />);
        expect(screen.getByRole("heading", { name: "Sandboxes" })).toBeInTheDocument();
    });
});
