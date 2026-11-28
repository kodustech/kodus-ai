/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import {
    partlyTestedRun,
    partlyTestedView,
} from "@services/runtime/model/__fixtures__/run-detail";
import { buildRunLog } from "@services/runtime/model/run-log";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import { runTiming } from "@services/runtime/model/run-timing";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";

import { RunLogView } from "./run-log";

const toast = jest.fn();
jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: (...args: unknown[]) => toast(...args),
}));
jest.mock("./evidence-link", () => ({
    EvidenceLink: ({
        children,
        stepId,
    }: {
        children: ReactNode;
        stepId: string;
    }) => (
        <button type="button" data-step={stepId}>
            {children}
        </button>
    ),
}));

const groups = () => {
    const run = partlyTestedRun();
    const view = partlyTestedView();
    return buildRunLog(
        run,
        view,
        buildRunPaths(run, view.steps),
        runTiming(run, view),
    );
};

const groupButton = (name: RegExp) => screen.getByRole("button", { name });

describe("RunLogView", () => {
    it("opens the failed group first, the others one click away", () => {
        render(<RunLogView runId="run-1" groups={groups()} />);
        expect(groupButton(/Explore the app on main/)).toHaveAttribute(
            "aria-expanded",
            "true",
        );
        expect(groupButton(/^Compare main and this PR/)).toHaveAttribute(
            "aria-expanded",
            "false",
        );
        expect(screen.getByText("cd /app/workspace && ls")).toBeInTheDocument();
        expect(screen.queryByText("check health")).not.toBeInTheDocument();

        fireEvent.click(groupButton(/^Compare main and this PR/));
        expect(screen.getAllByText("check health")).toHaveLength(3);
        // Every step keeps its evidence.
        expect(document.querySelector('[data-step="p1"]')).toBeInTheDocument();
    });

    it("filters to the failures and searches the lines", () => {
        render(<RunLogView runId="run-1" groups={groups()} />);
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Needs attention" }),
        );
        const log = screen.getByRole("list", { name: "Run log" });
        expect(within(log).queryByText(/Boot main/)).not.toBeInTheDocument();
        expect(within(log).getByText("cat go.mod")).toBeInTheDocument();

        fireEvent.click(
            screen.getByRole("checkbox", { name: "Needs attention" }),
        );
        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search the log" }),
            {
                target: { value: "make build" },
            },
        );
        expect(screen.getByText("app · RUN make build-go")).toBeInTheDocument();

        fireEvent.change(
            screen.getByRole("searchbox", { name: "Search the log" }),
            {
                target: { value: "nothing like this" },
            },
        );
        expect(screen.getByRole("status")).toHaveTextContent(
            "No line matches.",
        );
    });

    // Behavior: the clock toggle hides the UTC times on screen and in the copy, and the user is told the log was copied.
    it("hides the UTC clock on request and copies the log", async () => {
        toast.mockClear();
        const writeText = jest.fn().mockResolvedValue(undefined);
        Object.assign(navigator, { clipboard: { writeText } });
        render(<RunLogView runId="run-1" groups={groups()} />);
        expect(screen.getByText("18:14:27")).toBeInTheDocument();
        fireEvent.click(
            screen.getByRole("checkbox", { name: "Timestamps (UTC)" }),
        );
        expect(screen.queryByText("18:14:27")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Copy" }));
        // The copy settles after the clipboard's promise: its toast is what the user sees.
        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith(
                expect.objectContaining({ title: "Run log copied" }),
            ),
        );
        // The clipboard is the external port: what it received is the copied log.
        const copied = writeText.mock.calls[0][0] as string;
        expect(copied).toContain("$ cd /app/workspace && ls");
        expect(copied).not.toContain("18:14:27");
    });

    it("says why the log is short", () => {
        render(
            <RunLogView
                runId="run-1"
                groups={groups()}
                note="The stream is gone."
            />,
        );
        expect(screen.getByText("The stream is gone.")).toBeInTheDocument();
    });
});
