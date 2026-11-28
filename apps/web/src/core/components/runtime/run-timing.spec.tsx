/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    partlyTestedRun,
    partlyTestedView,
} from "@services/runtime/model/__fixtures__/run-detail";
import { runTiming } from "@services/runtime/model/run-timing";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { RunTimingView } from "./run-timing";

describe("RunTimingView", () => {
    const timing = () => runTiming(partlyTestedRun(), partlyTestedView());

    it("lists each phase on one row with its duration on the right", () => {
        render(<RunTimingView timing={timing()} />);
        const rows = within(screen.getByRole("list", { name: "Phases" }))
            .getAllByRole("listitem")
            .filter(
                (li) =>
                    li.parentElement?.getAttribute("aria-label") === "Phases",
            );
        // A row that opens shows its summary line while closed.
        const line = (li: HTMLElement) =>
            (li.querySelector("summary") ?? li).textContent;
        expect(rows.map(line)).toEqual([
            "Wait for a free machineQueued until a machine was free; Kody had not started yet20 s",
            "Boot main14 s",
            "Build this PR7 min 51 s",
            "Test1 check · 2 attempts on main, 1 on this PR1 min 08 s",
            "Report3 s",
        ]);
    });

    it("opens a phase to its slowest build steps, closed by default", () => {
        render(<RunTimingView timing={timing()} />);
        const build = screen.getByText("Build this PR").closest("details")!;
        expect(build.open).toBe(false);
        // Only a phase with steps to show opens.
        expect(screen.getByText("Report").closest("details")).toBeNull();
        fireEvent.click(build.querySelector("summary")!);
        expect(build.open).toBe(true);
        expect(
            within(build).getByText(/Build of this PR: 12 steps · 9 cached/),
        ).toBeInTheDocument();
        expect(
            within(build).getByText("RUN make build-go"),
        ).toBeInTheDocument();
        expect(within(build).getByText("6 min 40 s")).toBeInTheDocument();
    });

    it("says when the phases will appear before a machine takes the Run", () => {
        render(<RunTimingView timing={{ phases: [] }} />);
        expect(
            screen.getByText("The phases appear once a machine takes the Run."),
        ).toBeInTheDocument();
    });
});
