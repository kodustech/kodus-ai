/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import {
    regressionRun,
    regressionView,
} from "@services/runtime/model/__fixtures__/run-detail";
import { coverageRows } from "@services/runtime/model/coverage";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import { fireEvent, render, screen } from "@testing-library/react";

import { ExercisedFilesList, RunCoverageList } from "./run-coverage";

jest.mock("./evidence-link", () => ({
    EvidenceLink: ({ children }: { children: ReactNode }) => (
        <button type="button">{children}</button>
    ),
}));

const rows = () => {
    const run = regressionRun();
    return coverageRows(buildRunPaths(run, regressionView().steps), run);
};

describe("RunCoverageList", () => {
    it("labels each path and keeps its evidence one click away", () => {
        render(<RunCoverageList runId="run-2" rows={rows()} />);
        expect(screen.getByText("Same on both versions")).toBeInTheDocument();
        expect(screen.queryByText("Raw response")).not.toBeInTheDocument();

        const toggle = screen.getByRole("button", {
            name: "Show evidence for GET /cart",
        });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(screen.getAllByText("Raw response")).toHaveLength(2);
    });

    it("an untested path says what it needs, with a link to add it", () => {
        render(<RunCoverageList runId="run-2" rows={rows()} />);
        expect(screen.getByText("STRIPE_TEST_KEY")).toBeInTheDocument();
        expect(
            screen.getByRole("link", { name: "Add STRIPE_TEST_KEY" }),
        ).toHaveAttribute("href", "/runtime/environments/env-1");
    });

    it("names the file a route reaches as Kody's mapping, not as coverage", () => {
        const run = regressionRun();
        run.probes = run.probes!.map((p) =>
            p.probeId === "cart" ? { ...p, via: "pkg/cart/total.go" } : p,
        );
        const withVia = coverageRows(
            buildRunPaths(run, regressionView().steps),
            run,
        );
        expect(withVia.find((r) => r.entryPoint === "GET /cart")?.via).toBe(
            "pkg/cart/total.go",
        );
        render(<RunCoverageList runId="run-2" rows={withVia} />);
        expect(screen.getByText("pkg/cart/total.go")).toBeInTheDocument();
        expect(screen.getAllByText(/Kody's mapping/)).toHaveLength(1);
    });

    it("says when nothing was tested", () => {
        render(<RunCoverageList runId="run-2" rows={[]} />);
        expect(
            screen.getByText("This Run tested no path."),
        ).toBeInTheDocument();
    });
});

describe("ExercisedFilesList", () => {
    it("says how many changed lines of each file ran, and which were not measured", () => {
        render(
            <ExercisedFilesList
                files={[
                    {
                        path: "src/cart.ts",
                        changedLines: 10,
                        exercisedLines: 3,
                        status: "measured",
                    },
                    {
                        path: "src/legacy.js",
                        changedLines: 4,
                        exercisedLines: null,
                        status: "unknown",
                        reason: "no_coverage_written",
                    },
                ]}
            />,
        );
        const cart = screen.getByText("src/cart.ts").closest("li")!;
        expect(cart).toHaveTextContent("3 of 10 changed lines ran");
        const legacy = screen.getByText("src/legacy.js").closest("li")!;
        expect(legacy).toHaveTextContent("not measured");
        expect(legacy).toHaveTextContent("no_coverage_written");
        expect(legacy).not.toHaveTextContent("changed lines ran");
    });

    it("renders nothing without files", () => {
        const { container } = render(<ExercisedFilesList files={[]} />);
        expect(container).toBeEmptyDOMElement();
    });
});
