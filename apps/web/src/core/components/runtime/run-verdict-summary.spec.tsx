/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
    bootFailureRun,
    bootRegressionRun,
    partlyTestedRun,
    partlyTestedView,
    regressionRun,
} from "@services/runtime/model/__fixtures__/run-detail";
import { buildFindings } from "@services/runtime/model/findings";
import { runFacts } from "@services/runtime/model/run-facts";
import { buildRunPaths } from "@services/runtime/model/run-paths";
import { runStats, runSummary } from "@services/runtime/model/run-summary";
import type { RuntimeRun } from "@services/runtime/contracts";
import { render, screen, within } from "@testing-library/react";

import { RunVerdictSummary } from "./run-verdict-summary";

const props = (run = partlyTestedRun()) => {
    const steps = partlyTestedView().steps;
    const paths = buildRunPaths(run, steps);
    return {
        state: run.state,
        check: run.check,
        summary: runSummary(
            run,
            paths,
            buildFindings(run, steps),
            runFacts(run),
        ),
        stats: runStats(paths, 591_000),
        costUsd: run.cost?.totalUsd,
        publication: run.publication,
    };
};

describe("RunVerdictSummary", () => {
    it("shows unavailable comparison evidence neutrally while preserving the historical successful check", () => {
        const run = partlyTestedRun({
            state: "no_regressions",
            verdictState: "no_regressions",
            probes: [],
            findings: [],
            uncoveredEntryPoints: [],
            publication: undefined,
            check: {
                conclusion: "success",
                title: "Recorded successful check",
            },
        });
        render(<RunVerdictSummary {...props(run)} />);
        expect(
            screen.getByRole("heading", { name: "No comparison recorded" }),
        ).toBeInTheDocument();
        expect(screen.getByText(/Check:/)).toHaveTextContent("Check: Success");
        expect(screen.getByText("Regressions").nextSibling).toHaveTextContent(
            "Not recorded",
        );
        expect(screen.getByText("Paths tested").nextSibling).toHaveTextContent(
            "Comparison not recorded",
        );
        expect(
            screen.queryByText("Nothing is needed for this PR."),
        ).not.toBeInTheDocument();
        expect(run.check?.conclusion).toBe("success");
        expect(run.state).toBe("no_regressions");
    });

    it("does not publish internal errors or imply a verdict when comparison failed", () => {
        const run = partlyTestedRun({
            state: "errored",
            verdictState: undefined,
            probes: [],
            findings: [],
            uncoveredEntryPoints: [],
        });
        const reason =
            "hub 400 http://host.orb.internal:3420/upload?token=private-value pattern \u0022^https?://[^.]+$\u0022";
        const { container } = render(
            <RunVerdictSummary {...props(run)} reason={reason} />,
        );
        expect(screen.getByText("Regressions").nextSibling).toHaveTextContent(
            "No verdict",
        );
        expect(screen.getByText("Paths tested").nextSibling).toHaveTextContent(
            "Comparison incomplete",
        );
        expect(container.textContent).not.toContain("host.orb.internal");
        expect(container.textContent).not.toContain("private-value");
        expect(container.textContent).not.toContain("^https?");
        expect(container.textContent).not.toContain("0 of 0");
    });

    it("preserves recorded results when a later infrastructure error interrupts the Run", () => {
        const run = partlyTestedRun({ state: "errored" });
        render(
            <RunVerdictSummary
                {...props(run)}
                reason="private internal error"
            />,
        );
        expect(screen.getByText("Paths tested").nextSibling).toHaveTextContent(
            "1 of 2",
        );
        expect(
            screen.queryByText("Comparison incomplete"),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByText("private internal error"),
        ).not.toBeInTheDocument();
    });

    it("preserves the count of inconclusive probes while explaining the incomplete comparison", () => {
        const run = partlyTestedRun({
            state: "errored",
            probes: [
                {
                    probeId: "reset-failed",
                    entryPoint: "GET /orders",
                    verdict: "inconclusive",
                    reason: "reset failed",
                    baseStepIds: [],
                    prStepIds: [],
                },
            ],
        });
        render(<RunVerdictSummary {...props(run)} />);
        expect(screen.getByText("Paths tested").nextSibling).toHaveTextContent(
            "0 of 2",
        );
        expect(
            screen.getByText(/The comparison did not finish/),
        ).toBeInTheDocument();
    });

    it("preserves a boot finding even when there are no path rows", () => {
        const run = bootRegressionRun({ state: "errored" });
        const input = props(run);
        const noPaths = {
            paths: [],
            untested: [],
            testedCount: 0,
            totalCount: 0,
        };
        const summary = runSummary(
            run,
            noPaths,
            buildFindings(run, []),
            runFacts(run),
        );
        render(
            <RunVerdictSummary
                {...input}
                summary={summary}
                stats={runStats(noPaths, 1_000)}
            />,
        );
        expect(screen.queryByText("No verdict")).not.toBeInTheDocument();
        expect(
            screen.queryByText("Comparison incomplete"),
        ).not.toBeInTheDocument();
    });

    it.each(["intended", "unintended"] as const)(
        "preserves a recorded %s finding after an error",
        (intent) => {
            const run = regressionRun({
                state: "errored",
                probes: regressionRun().probes!.filter(
                    (probe) => probe.intent === intent,
                ),
                findings: [],
                uncoveredEntryPoints: [],
            });
            render(<RunVerdictSummary {...props(run)} />);
            expect(
                screen.getByText("Paths tested").nextSibling,
            ).toHaveTextContent("1 of 1");
            expect(
                screen.getByText("Regressions").nextSibling,
            ).toHaveTextContent(intent === "intended" ? "0" : "1");
            expect(screen.queryByText("No verdict")).not.toBeInTheDocument();
        },
    );

    it("leads with the verdict, the headline, what to do and the numbers", () => {
        render(<RunVerdictSummary {...props()} checkPlatform="GitHub" />);
        expect(screen.getByText("Partly tested")).toBeInTheDocument();
        expect(screen.getByText(/Check on GitHub:/)).toHaveTextContent(
            "Check on GitHub: Neutral",
        );
        expect(
            screen.getByRole("heading", {
                name: "No regressions in what Kody could test",
            }),
        ).toBeInTheDocument();
        expect(screen.getByText("What you can do")).toBeInTheDocument();
        expect(screen.getByText("Paths tested").nextSibling).toHaveTextContent(
            "1 of 2",
        );
        expect(screen.getByText("Took").nextSibling).toHaveTextContent(
            "9 min 51 s",
        );
        expect(
            screen.getByText("Cost (estimate)").closest("a"),
        ).toHaveAttribute("href", "#run-cost");
    });

    it("says on one row what the PR shows, retries included", () => {
        render(<RunVerdictSummary {...props()} />);
        expect(screen.getByText("On the PR:")).toBeInTheDocument();
        expect(
            screen.getByText(/Check: On the pull request/),
        ).toBeInTheDocument();
        expect(screen.getByText("Comment: Retrying")).toBeInTheDocument();
    });

    it("a simulation says nothing is posted", () => {
        const run = partlyTestedRun({
            publication: {
                ...partlyTestedRun().publication!,
                postsToPullRequest: false,
            },
        });
        render(<RunVerdictSummary {...props(run)} />);
        expect(screen.getByRole("note")).toHaveTextContent(/nothing is posted/);
    });

    it("lifts 'What you can do' above the contrast floor of the card", () => {
        render(<RunVerdictSummary {...props()} />);
        expect(screen.getByText("What you can do")).toHaveClass(
            "text-text-secondary",
        );
    });

    it("reads '—' for regressions when nothing was compared, never 0", () => {
        const run = bootFailureRun({
            state: "could_not_boot",
            probes: [],
            uncoveredEntryPoints: [],
            uncovered: [],
        });
        render(<RunVerdictSummary {...props(run)} />);
        const value = screen.getByText("Regressions")
            .nextSibling as HTMLElement;
        expect(value).toHaveTextContent("—None compared");
        expect(value).not.toHaveTextContent("0");
    });

    it("does not say the check is on GitHub when it was not posted", () => {
        const run = partlyTestedRun({
            publication: {
                ...partlyTestedRun().publication!,
                check: { status: "skipped" },
            },
        });
        render(<RunVerdictSummary {...props(run)} checkPlatform="GitHub" />);
        expect(screen.queryByText(/Check on GitHub/)).toBeNull();
        expect(screen.getByText(/Check result:/)).toHaveTextContent(
            "Check result: Neutral",
        );
        expect(screen.getByText(/Check: Not posted/)).toBeInTheDocument();
    });

    it("tells the admin which permission the token needs when the commit status was refused", () => {
        const run = partlyTestedRun({
            publication: {
                ...partlyTestedRun().publication!,
                check: {
                    status: "skipped",
                    reason: "status_permission_missing",
                },
            },
        });
        render(<RunVerdictSummary {...props(run)} checkPlatform="GitHub" />);
        expect(screen.getByText(/Check: Not posted/)).toBeInTheDocument();
        expect(
            screen.getByText(/cannot write commit statuses/),
        ).toHaveTextContent(
            'The GitHub token connected to Kodus cannot write commit statuses. Give it the "Commit statuses: Read and write" permission (fine-grained token) or the repo:status scope (classic token); the comment carries the result meanwhile.',
        );
        expect(screen.queryByText(/has no checks/)).toBeNull();
    });

    it("offers the one action the page chose, and says how sure Kody is", () => {
        const input = props(regressionRun());
        render(
            <RunVerdictSummary
                {...input}
                summary={{
                    ...input.summary,
                    certainty: "Same answer in 2 of 2 attempts on each side",
                }}
                primaryAction={<button type="button">Open the finding</button>}
            />,
        );
        expect(screen.getByText(/^How sure:/).parentElement).toHaveTextContent(
            "How sure: Same answer in 2 of 2 attempts on each side.",
        );
        const todo = screen
            .getByText("What you can do")
            .closest("div")!.parentElement!;
        expect(
            within(todo).getByRole("button", { name: "Open the finding" }),
        ).toBeInTheDocument();
    });

    it("draws the todo's link as the action when there is no other", () => {
        const run = bootFailureRun({
            state: "could_not_boot",
            bootFailure: {
                ...bootFailureRun().bootFailure!,
                kind: "toolchain",
                signature: "toolchain:go",
            },
        });
        render(<RunVerdictSummary {...props(run)} />);
        expect(
            screen.getByRole("link", { name: "Open the setup file" }),
        ).toHaveClass("bg-primary-light");
    });

    describe("changed lines exercised", () => {
        const exercised = (
            summary: Partial<
                NonNullable<RuntimeRun["exercised"]>["summary"]
            >,
        ): RuntimeRun["exercised"] => ({
            summary: {
                exercised: 0,
                changed: 0,
                threshold: 0.5,
                measured: false,
                ...summary,
            },
            files: [],
        });
        const fact = () => screen.queryByText(/Changed lines exercised/);

        it("states how many changed lines ran, and the share the repo asks when fewer ran", () => {
            const run = partlyTestedRun({
                exercised: exercised({
                    exercised: 3,
                    changed: 10,
                    language: "node",
                    measured: true,
                }),
            });
            render(<RunVerdictSummary {...props(run)} />);
            expect(fact()).toHaveTextContent(
                "Changed lines exercised: 3 of 10, below the 50% this repo asks.",
            );
        });

        it.each([
            [7, 0.5],
            [0, 0],
        ])(
            "names no threshold when %i of 10 ran and the Run asked %d",
            (ran, threshold) => {
                const run = partlyTestedRun({
                    exercised: exercised({
                        exercised: ran,
                        changed: 10,
                        threshold,
                        language: "node",
                        measured: true,
                    }),
                });
                render(<RunVerdictSummary {...props(run)} />);
                expect(fact()).toHaveTextContent(
                    new RegExp(`^Changed lines exercised: ${ran} of 10\\.$`),
                );
            },
        );

        it.each(["node", "unsupported"] as const)(
            "says it was not measured for %s",
            (language) => {
                const run = partlyTestedRun({
                    exercised: exercised({ language, measured: false }),
                });
                render(<RunVerdictSummary {...props(run)} />);
                expect(fact()).toHaveTextContent(
                    `Changed lines exercised: not measured for ${language}.`,
                );
            },
        );

        it("says it was not measured, never 0 of N, when the coverage mapped to no source", () => {
            const run = partlyTestedRun({
                exercised: exercised({
                    language: "node",
                    measured: false,
                    reason: "no_source_map",
                }),
            });
            render(<RunVerdictSummary {...props(run)} />);
            expect(fact()).toHaveTextContent(
                /^Changed lines exercised: not measured \(no source map\)\.$/,
            );
        });

        it("says it was not measured when the language is unknown", () => {
            const run = partlyTestedRun({
                exercised: exercised({ measured: false }),
            });
            render(<RunVerdictSummary {...props(run)} />);
            expect(fact()).toHaveTextContent(
                /^Changed lines exercised: not measured\.$/,
            );
        });

        it("states nothing for a report without the field", () => {
            render(<RunVerdictSummary {...props(partlyTestedRun())} />);
            expect(fact()).not.toBeInTheDocument();
        });
    });
});
