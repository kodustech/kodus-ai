/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import {
    partlyTestedRun,
    partlyTestedView,
} from "@services/runtime/model/__fixtures__/run-detail";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import {
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";

import { TestedPathsView, testedSummary } from "./tested-paths";

const useRunReproduction = jest.fn();
jest.mock("@services/runtime/queries", () => ({
    useFindingFeedback: jest.fn(),
    useRunReproduction: (...args: unknown[]) => useRunReproduction(...args),
}));
jest.mock("./evidence-link", () => ({
    EvidenceLink: ({ children }: { children: ReactNode }) => (
        <button type="button">{children}</button>
    ),
}));

const at = (s: number) =>
    new Date(Date.UTC(2026, 9, 31, 14, 2, s)).toISOString();

const runPaths = buildRunPaths(
    {
        baseBranch: "main",
        probes: [
            {
                probeId: "orders-list",
                entryPoint: "GET /orders",
                verdict: "not_reproduced",
                reason: "same",
                baseStepIds: ["b2"],
                prStepIds: ["p2"],
            },
            {
                probeId: "empty-cart",
                entryPoint: "POST /orders",
                verdict: "finding",
                intent: "unintended",
                reason: "status differs",
                baseStepIds: ["b1"],
                prStepIds: ["p1"],
            },
        ],
        uncoveredEntryPoints: ["POST /payments"],
    },
    [
        {
            stepId: "b1",
            side: "base",
            status: 400,
            startedAt: at(1),
            finishedAt: at(2),
        },
        {
            stepId: "p1",
            side: "pr",
            status: 500,
            startedAt: at(3),
            finishedAt: at(4),
        },
        {
            stepId: "b2",
            side: "base",
            status: 200,
            startedAt: at(5),
            finishedAt: at(6),
        },
        {
            stepId: "p2",
            side: "pr",
            status: 200,
            startedAt: at(7),
            finishedAt: at(8),
        },
    ],
);

const { paths, untested } = runPaths;

describe("TestedPathsView (screen 8)", () => {
    it.each(["release/2026", undefined])(
        "keeps the base label through a selectable evidence step (%j)",
        (baseBranch) => {
            const label = baseBranch || "base version";
            const record = partlyTestedRun({ baseBranch });
            const model = buildRunPaths(record, partlyTestedView().steps);
            render(
                <TestedPathsView
                    runId="run-1"
                    paths={model.paths}
                    untested={[]}
                />,
            );
            fireEvent.click(
                screen.getByRole("button", { name: /GET \/api\/health/ }),
            );
            const step = screen.getAllByRole("button", {
                name: new RegExp(`Send GET /api/health on ${label}`),
            })[0];
            step.focus();
            expect(step).toHaveFocus();
            fireEvent.click(step);
            expect(step).toHaveAttribute("aria-current", "true");
            expect(
                screen.getByText(new RegExp(`· ${label}$`)),
            ).toBeInTheDocument();
            expect(screen.queryByText(/Same on main/)).not.toBeInTheDocument();
        },
    );

    it("does not mark inconclusive responses as expected or expired evidence as still running", () => {
        const record = {
            probes: [
                {
                    probeId: "unstable",
                    entryPoint: "GET /orders",
                    verdict: "inconclusive" as const,
                    reason: "base answers varied",
                    baseStepIds: ["b"],
                    prStepIds: ["p"],
                },
            ],
        };
        const finished = ["b", "p"].map((stepId) => ({
            stepId,
            status: 200,
            finishedAt: at(2),
        }));
        const initial = buildRunPaths(record, finished);
        const { rerender } = render(
            <TestedPathsView
                runId="run-1"
                paths={initial.paths}
                untested={[]}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /GET \/orders/ }));
        expect(screen.queryByLabelText("As expected")).not.toBeInTheDocument();
        expect(screen.getAllByLabelText("Not verified")).toHaveLength(2);

        const expired = buildRunPaths(record, []);
        rerender(
            <TestedPathsView
                runId="run-1"
                paths={expired.paths}
                untested={[]}
            />,
        );
        expect(screen.getByText("Response not recorded")).toBeInTheDocument();
        expect(screen.queryByLabelText("Running")).not.toBeInTheDocument();
    });

    it("opens the first regression with expected vs observed and its evidence", () => {
        render(
            <TestedPathsView
                runId="run-1"
                headSha={"a".repeat(40)}
                paths={paths}
                untested={untested}
                onVote={jest.fn()}
            />,
        );
        const regression = screen.getByRole("button", {
            name: /POST \/orders.*Regression/,
        });
        expect(regression).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByText("Expected 400, like main, got 500"),
        ).toBeInTheDocument();
        expect(
            screen.getByText(
                /02 · Send the same request on this PR · this PR @ aaaaaaa/,
            ),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: /GET \/orders.*Same on both versions/,
            }),
        ).toHaveAttribute("aria-expanded", "false");
        expect(screen.getByText("POST /payments")).toBeInTheDocument();
    });

    it("expands a row on click and selects a step for the evidence", () => {
        render(<TestedPathsView runId="run-1" paths={paths} untested={[]} />);
        const row = screen.getByRole("button", { name: /GET \/orders/ });
        fireEvent.click(row);
        expect(row).toHaveAttribute("aria-expanded", "true");
        const body = document.getElementById("path-orders-list-body")!;
        fireEvent.click(
            within(body).getByRole("button", {
                name: /Send GET \/orders on main/,
            }),
        );
        expect(
            within(body).getByText(/01 · Send GET \/orders on main · main/),
        ).toBeInTheDocument();
    });

    it("votes up, and a second click on the same vote clears it", () => {
        const onVote = jest.fn();
        const { rerender } = render(
            <TestedPathsView
                runId="run-1"
                paths={paths}
                untested={[]}
                onVote={onVote}
                feedback={{}}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", { name: "Useful: POST /orders" }),
        );
        expect(onVote).toHaveBeenLastCalledWith("empty-cart", "up");
        rerender(
            <TestedPathsView
                runId="run-1"
                paths={paths}
                untested={[]}
                onVote={onVote}
                feedback={{ "empty-cart": { up: 1, down: 0, mine: "up" } }}
            />,
        );
        const up = screen.getByRole("button", { name: "Useful: POST /orders" });
        expect(up).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(up);
        expect(onVote).toHaveBeenLastCalledWith("empty-cart", null);
        fireEvent.click(
            screen.getByRole("button", { name: "Not useful: POST /orders" }),
        );
        expect(onVote).toHaveBeenLastCalledWith("empty-cart", "down");
    });

    it("says how many paths were tested, from the rows it draws", () => {
        expect(testedSummary(runPaths)).toBe("2 of 3 paths tested");
    });

    it("says when nothing was tested yet", () => {
        render(<TestedPathsView runId="run-1" paths={[]} untested={[]} live />);
        expect(
            screen.getByText("Tested paths appear here as Kody runs them."),
        ).toBeInTheDocument();
    });

    it("offers inert reproduction data on a regression and fetches only when opened", async () => {
        useRunReproduction.mockReturnValue({
            isPending: false,
            isError: false,
            data: {
                filename: "kody-repro-pr7-empty-cart.json",
                manifest: {
                    schemaVersion: 1,
                    kind: "kodus.runtime.reproduction",
                    run: {
                        runId: "run-1",
                        repositoryName: "acme/shop",
                        prNumber: 7,
                        baseSha: "a".repeat(40),
                        headSha: "b".repeat(40),
                    },
                    probe: {
                        probeId: "empty-cart",
                        entryPoint: "POST /orders",
                        purpose: "empty cart",
                        expected: "400",
                        spec: {
                            kind: "http",
                            target: { service: "web", port: 3000 },
                            method: "POST",
                            path: "/orders",
                            timeoutMs: 1000,
                        },
                    },
                },
            },
        });
        const { rerender } = render(
            <TestedPathsView
                runId="run-1"
                paths={paths}
                untested={untested}
                reproducible={["empty-cart", "orders-list"]}
            />,
        );
        // orders-list is the same on both sides: nothing to reproduce there.
        expect(
            screen.getAllByRole("button", {
                name: /Reproduction data/,
            }),
        ).toHaveLength(1);
        expect(useRunReproduction).toHaveBeenLastCalledWith(
            "run-1",
            "empty-cart",
            false,
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Reproduction data: POST /orders",
            }),
        );
        expect(useRunReproduction).toHaveBeenLastCalledWith(
            "run-1",
            "empty-cart",
            true,
        );
        const dialog = screen.getByRole("dialog");
        expect(
            within(dialog).getByText(/"schemaVersion": 1/),
        ).toBeInTheDocument();
        expect(within(dialog).getByText(/Data only/)).toBeInTheDocument();
        expect(within(dialog).queryByText(/bash|docker compose/)).toBeNull();
        const clipboard = navigator.clipboard;
        const createObjectURL = URL.createObjectURL;
        const revokeObjectURL = URL.revokeObjectURL;
        const writeText = jest.fn().mockResolvedValue(undefined);
        const blobUrl = jest.fn().mockReturnValue("blob:reproduction-data");
        const revoke = jest.fn();
        let filename: string | undefined;
        const click = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(function (this: HTMLAnchorElement) {
                filename = this.download;
            });
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });
        URL.createObjectURL = blobUrl;
        URL.revokeObjectURL = revoke;
        try {
            expect(blobUrl).not.toHaveBeenCalled();
            fireEvent.click(
                within(dialog).getByRole("button", { name: "Copy JSON" }),
            );
            await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
            expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(
                useRunReproduction.mock.results.at(-1)!.value.data.manifest,
            );
            fireEvent.click(
                within(dialog).getByRole("button", { name: "Download JSON" }),
            );
            const blob = blobUrl.mock.calls[0][0] as Blob;
            expect(blob.type).toBe("application/json");
            const downloaded = await new Promise<string>((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.readAsText(blob);
            });
            expect(downloaded).toBe(writeText.mock.calls[0][0]);
            expect(filename).toBe("kody-repro-pr7-empty-cart.json");
            expect(revoke).toHaveBeenCalledWith("blob:reproduction-data");
        } finally {
            click.mockRestore();
            Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: clipboard,
            });
            URL.createObjectURL = createObjectURL;
            URL.revokeObjectURL = revokeObjectURL;
        }
        rerender(
            <TestedPathsView runId="run-1" paths={paths} untested={untested} />,
        );
        expect(
            screen.queryByRole("button", {
                name: /Reproduction data:/,
            }),
        ).toBeNull();
    });

    it("refuses a cached legacy script response instead of offering it for copying or download", () => {
        useRunReproduction.mockReturnValue({
            isPending: false,
            isError: false,
            data: {
                filename: "legacy.sh",
                script: "#!/usr/bin/env bash\necho forbidden",
            },
        });
        render(
            <TestedPathsView
                runId="run-1"
                paths={paths}
                untested={untested}
                reproducible={["empty-cart"]}
            />,
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: "Reproduction data: POST /orders",
            }),
        );
        const dialog = screen.getByRole("dialog");
        expect(within(dialog).getByRole("alert")).toHaveTextContent(
            "Reproduction data is unavailable",
        );
        expect(
            within(dialog).getByRole("button", { name: "Copy JSON" }),
        ).toBeDisabled();
        expect(
            within(dialog).getByRole("button", { name: "Download JSON" }),
        ).toBeDisabled();
        expect(within(dialog).queryByText(/echo forbidden/)).toBeNull();
    });
});
