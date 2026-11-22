import {
    bootFailureRun,
    bootRegressionRun,
    newRouteRun,
    newRouteView,
    partlyTestedRun,
    partlyTestedView,
    regressionRun,
    regressionView,
    sumdbBootFailure,
} from "./__fixtures__/run-detail";
import { coverageRows } from "./coverage";
import { buildFindings } from "./findings";
import { regressionSentence } from "./pull-request-runs";
import { plainText } from "./rich-text";
import { runFacts } from "./run-facts";
import { buildRunPaths } from "./run-paths";
import {
    factSentences,
    missingVariables,
    runStats,
    runSummary,
} from "./run-summary";

const summaryOf = (
    run: ReturnType<typeof partlyTestedRun>,
    steps = partlyTestedView().steps,
) =>
    runSummary(
        run,
        buildRunPaths(run, steps),
        buildFindings(run, steps),
        runFacts(run),
    );

describe("runSummary", () => {
    it.each(["release/2026", undefined])(
        "names the environment recipe without inferring its source branch (%j)",
        (baseBranch) => {
            const record = partlyTestedRun({
                baseBranch,
                recipeChangedInPr: [".kodus/workspace.yaml"],
            });
            const text = summaryOf(record).explanation.map(plainText).join(" ");
            expect(text).toContain("the environment's recorded setup file");
            expect(text).not.toContain("release/2026's recipe");
            expect(text).not.toContain("base version's recipe");
            expect(text).toContain("so that change was not tested");
            // Said here, so the page does not repeat it.
            expect(summaryOf(record).saysSetupFileChange).toBe(true);
            expect(
                summaryOf(partlyTestedRun()).saysSetupFileChange,
            ).toBeUndefined();
            expect(record.state).toBe("partly_tested");
        },
    );

    it.each(["release/2026", undefined])(
        "names the actual base or a neutral base version throughout the summary (%j)",
        (baseBranch) => {
            const label = baseBranch || "base version";
            expect(
                summaryOf(partlyTestedRun({ state: "booting", baseBranch }))
                    .headline,
            ).toBe(`Booting ${label} and this PR`);
            expect(
                summaryOf(partlyTestedRun({ state: "testing", baseBranch }))
                    .headline,
            ).toBe(`Testing this PR against ${label}`);
            expect(
                summaryOf(partlyTestedRun({ baseBranch }))
                    .explanation.map(plainText)
                    .join(" "),
            ).toContain(`Kody booted ${label} and this PR`);
            expect(summaryOf(bootRegressionRun({ baseBranch })).headline).toBe(
                `This PR does not boot, and ${label} does`,
            );
        },
    );

    it.each([undefined, []] as const)(
        "scopes a historical success to recorded comparisons while distinguishing missing coverage (%j)",
        (uncoveredEntryPoints) => {
            const run = partlyTestedRun({
                state: "no_regressions",
                uncoveredEntryPoints: uncoveredEntryPoints && [
                    ...uncoveredEntryPoints,
                ],
            });
            const summary = summaryOf(run, []);
            expect(summary.headline).toBe(
                "No regressions in the recorded comparisons",
            );
            expect(summary.explanation.map(plainText).join(" ")).toContain(
                "only the recorded checks",
            );
            expect(
                summary.explanation
                    .map(plainText)
                    .join(" ")
                    .includes("Coverage of all changed paths was not recorded"),
            ).toBe(uncoveredEntryPoints === undefined);
            expect(plainText(summary.todo!.text)).toBe(
                "Review the recorded comparisons and continue your usual code review.",
            );
            expect(run.state).toBe("no_regressions");
        },
    );

    it("does not turn a historical successful check into proof when no completed comparison remains in the record", () => {
        const run = partlyTestedRun({
            state: "no_regressions",
            probes: [],
            findings: [],
            uncoveredEntryPoints: [],
        });
        const summary = summaryOf(run, []);
        expect(summary.headline).toBe("No comparison recorded");
        expect(summary.explanation.map(plainText).join(" ")).toContain(
            "cannot confirm what was compared",
        );
        expect(summary.explanation.map(plainText).join(" ")).not.toMatch(
            /nothing was compared|never ran|did not run/i,
        );
        expect(plainText(summary.todo!.text)).toContain("usual code review");
        expect(run.state).toBe("no_regressions");
    });

    it("counts matching changed entry points once and excludes outside observations from the coverage explanation", () => {
        const base = partlyTestedRun();
        const comparison = base.probes![0];
        const run = partlyTestedRun({
            probes: [
                comparison,
                { ...comparison, probeId: "another-check" },
                {
                    ...comparison,
                    probeId: "outside-check",
                    entryPoint: "unmapped",
                    exercised: "GET /other-health",
                },
            ],
        });
        const summary = summaryOf(run, []);
        expect(summary.explanation.map(plainText).join(" ")).toContain(
            "On 1 of 2 paths they answered the same.",
        );
    });

    it("does not describe a changed entry point with a regression as another matching path", () => {
        const base = regressionRun();
        const regression = base.probes!.find(
            (probe) => probe.verdict === "finding",
        )!;
        const run = regressionRun({
            probes: [
                regression,
                {
                    ...regression,
                    probeId: "matching-check",
                    verdict: "not_reproduced",
                    differingFields: [],
                },
            ],
            uncoveredEntryPoints: [],
        });
        expect(
            summaryOf(run, []).explanation.map(plainText).join(" "),
        ).not.toContain("other tested path");
    });

    it("an error before any result says that the comparison did not finish", () => {
        const run = partlyTestedRun({
            state: "errored",
            probes: [],
            findings: [],
            uncoveredEntryPoints: [],
        });
        const summary = summaryOf(run, []);
        expect(summary.explanation.map(plainText)).toEqual([
            "The comparison did not finish. No verdict was reached.",
        ]);
        expect(plainText(summary.todo!.text)).toContain("Run again");
        expect(plainText(summary.todo!.text)).toContain(
            "share this Run link with support",
        );
    });

    it("an error after recorded results keeps them visible without denying their verdict", () => {
        const summary = summaryOf(partlyTestedRun({ state: "errored" }));
        expect(summary.explanation.map(plainText)).toEqual([
            "The comparison did not finish. Recorded check results remain available below; the remaining paths have no verdict.",
        ]);
        expect(summary.explanation.map(plainText).join(" ")).not.toContain(
            "before a verdict",
        );
    });

    it("keeps a boot finding as a recorded verdict when there are no path rows", () => {
        const run = bootRegressionRun({
            state: "errored",
            verdictState: undefined,
        });
        const summary = runSummary(
            run,
            { paths: [], untested: [], testedCount: 0, totalCount: 0 },
            buildFindings(run, []),
            runFacts(run),
        );
        expect(summary.hasRecordedVerdict).toBe(true);
        expect(summary.explanation.map(plainText).join(" ")).toContain(
            "Recorded check results remain available below",
        );
    });

    it("partly tested: what held, what was not reached, and how to cover it", () => {
        const s = summaryOf(partlyTestedRun());
        expect(s.headline).toBe("No regressions in what Kody could test");
        expect(s.explanation.map(plainText)).toEqual([
            "Kody booted main and this PR side by side and sent the same requests to both. On 1 of 2 paths they answered the same.",
            "Not tested: pkg/main.go: no check reached it.",
        ]);
        expect(plainText(s.todo!.text)).toBe(
            "Nothing is needed for what was tested. To cover pkg/main.go next time, point Kody at a test or an HTTP path that runs it in .kodus/workspace.yaml.",
        );
    });

    it("regression: the headline says what the PR list says about the same finding", () => {
        const run = regressionRun({
            probes: [
                {
                    probeId: "outside",
                    entryPoint: "unmapped",
                    exercised: "GET /health",
                    verdict: "finding",
                    intent: "unintended",
                    reason: "a field differs",
                    differingFields: ["json.status"],
                    responseDiff: {
                        fields: [{ path: "json.status", base: '"ok"', pr: '"degraded"' }],
                        truncated: false,
                    },
                    baseStepIds: ["rb1"],
                    prStepIds: ["rp1"],
                },
            ],
            probeRequests: {
                outside: {
                    kind: "http",
                    method: "GET",
                    path: "/health",
                    purpose: "health check reports the service status",
                    expected: "status stays ok",
                },
            },
        });
        const s = summaryOf(run, regressionView().steps);
        expect(s.headline).toBe(
            regressionSentence(
                {
                    title: "health check reports the service status",
                    field: { path: "json.status", base: '"ok"', pr: '"degraded"' },
                    differingFields: ["json.status"],
                    // The fixture rounds answered 201 on main and 500 on this PR: the status leads.
                    status: { base: 201, pr: 500 },
                    boot: false,
                    destabilizes: false,
                },
                "main",
            ),
        );
        expect(s.headline).not.toContain("unmapped");
    });

    it("regression: never names an internal probe id, even without what the probe checked", () => {
        const run = regressionRun({
            probes: [
                {
                    probeId: "outside",
                    entryPoint: "unmapped",
                    verdict: "finding",
                    intent: "unintended",
                    reason: "differs",
                    differingFields: ["status"],
                    baseStepIds: ["rb1"],
                    prStepIds: ["rp1"],
                },
                {
                    probeId: "outside-2",
                    entryPoint: "unmapped",
                    exercised: "GET /ping",
                    verdict: "finding",
                    intent: "unintended",
                    reason: "differs",
                    differingFields: ["status"],
                    baseStepIds: ["rb2"],
                    prStepIds: ["rp2"],
                },
            ],
            reproducible: [],
        });
        const one = summaryOf(
            { ...run, probes: run.probes!.slice(0, 1) },
            regressionView().steps,
        );
        const two = summaryOf(run, regressionView().steps);
        for (const s of [one, two]) {
            expect(s.headline).not.toContain("unmapped");
            expect(s.explanation.map(plainText).join(" ")).not.toContain(
                "unmapped",
            );
        }
    });

    it("regression: names both answers, and says what to do", () => {
        const run = regressionRun();
        const s = summaryOf(run, regressionView().steps);
        expect(plainText(s.explanation[0])).toBe(
            "The same request got 201 on main and 500 on this PR, on every attempt.",
        );
        expect(plainText(s.explanation[1])).toBe(
            "The other tested path behaves the same.",
        );
        expect(plainText(s.explanation[2])).toBe(
            "Not tested, blocked: POST /payments.",
        );
    });

    it("nothing tested: does not say nothing is needed, and names the refused check", () => {
        const run = partlyTestedRun({ probes: [] });
        const steps = partlyTestedView().steps;
        const s = runSummary(
            run,
            buildRunPaths(run, steps),
            buildFindings(run, steps),
            runFacts(run, {
                verdict: {
                    at: "t",
                    rejectedProbes: 1,
                    rejectedReasons: [
                        "test: the test command must run the file it names",
                    ],
                },
            }),
        );
        expect(s.headline).toBe("Kody could not test any path of this PR");
        expect(s.explanation.map(plainText)).toEqual([
            "Not tested: pkg/main.go: no check reached it.",
            "Kody wrote 1 check that the plan validation refused before it ran: test: the test command must run the file it names.",
        ]);
        expect(plainText(s.todo!.text)).toBe(
            "To test pkg/main.go next time, point Kody at a test or an HTTP path that runs it in .kodus/workspace.yaml.",
        );
    });

    it("a regression the record does not carry yet never reads as '0 paths'", () => {
        const run = regressionRun({ probes: [] });
        const s = summaryOf(run, regressionView().steps);
        expect(s.headline).toBe("Kody found a regression on this PR");
        expect(plainText(s.explanation[0])).toMatch(
            /does not carry the finding yet/,
        );
    });

    it("a blocked variable turns into the thing to add", () => {
        const run = regressionRun({
            state: "partly_tested",
            probes: [regressionRun().probes![1]],
        });
        const s = summaryOf(run, regressionView().steps);
        expect(plainText(s.todo!.text)).toBe(
            "Add STRIPE_TEST_KEY to the environment, then run again to cover what was blocked.",
        );
        expect(s.todo!.link?.href).toBe("/runtime/environments/env-1");
        expect(missingVariables(run.uncovered)).toEqual(["STRIPE_TEST_KEY"]);
    });

    it("no regressions, live and ended states each have their own headline", () => {
        const run = partlyTestedRun({
            state: "no_regressions",
            uncoveredEntryPoints: [],
        });
        expect(summaryOf(run).headline).toBe(
            "No regressions in the recorded comparisons",
        );
        expect(plainText(summaryOf(run).todo!.text)).toBe(
            "Review the recorded comparisons and continue your usual code review.",
        );
        expect(summaryOf(partlyTestedRun({ state: "booting" })).headline).toBe(
            "Booting main and this PR",
        );
        expect(
            summaryOf(partlyTestedRun({ state: "could_not_boot" })).todo?.link
                ?.label,
        ).toBe("Open the setup file");
        expect(summaryOf(partlyTestedRun({ state: "skipped" })).headline).toBe(
            "Kody did not run on this PR",
        );
        expect(
            summaryOf(partlyTestedRun({ state: "superseded" })).todo,
        ).toBeUndefined();
    });

    it("says each neutral fact in a sentence", () => {
        expect(
            factSentences({
                blockedOutbound: 2,
                dependencyChangeUntested: true,
                diffTruncated: true,
                recipeChangedInPr: [".kodus/workspace.yaml"],
            }).map(plainText),
        ).toEqual([
            "This PR changes .kodus/workspace.yaml, but Kody boots every pull request with the environment's recorded setup file, so that change was not tested.",
            "This PR changes dependencies, a Dockerfile, compose or CI files that no check exercised.",
            "The app tried 2 outbound requests that the sandbox blocked, so the check stays neutral.",
            "The diff was too large to test whole: what was cut is untested.",
        ]);
    });

    it("counts the stats from the same rows the page draws", () => {
        const run = regressionRun();
        expect(
            runStats(buildRunPaths(run, regressionView().steps), 591_000),
        ).toEqual({
            regressions: 1,
            tested: 3,
            total: 4,
            tookMs: 591_000,
        });
    });
});

describe("could not boot, with the cell's boot failure", () => {
    it("names the side and the title, and stays generic without it", () => {
        const run = bootFailureRun({
            state: "could_not_boot",
            bootFailure: undefined,
            bootFailureDetail: {
                ...sumdbBootFailure(),
                side: "base",
                kind: "toolchain",
                signature: "toolchain:go",
            },
        });
        expect(plainText(summaryOf(run).explanation[0])).toBe(
            "Main did not get ready, so nothing was compared: The build checks github.com/Masterminds/semver/v3@v3.4.0 against the Go checksum database, which the sandbox does not reach. The log it left is below.",
        );
        expect(
            plainText(
                summaryOf(
                    bootFailureRun({
                        state: "could_not_boot",
                        bootFailure: undefined,
                    }),
                ).explanation[0],
            ),
        ).toBe("Main or this PR did not get ready, so nothing was compared.");
    });
});

describe("a PR that does not boot while main does", () => {
    it("says so, with the cell's cause, instead of comparing answers", () => {
        const summary = summaryOf(bootRegressionRun(), []);
        expect(summary.headline).toBe("This PR does not boot, and main does");
        expect(plainText(summary.explanation[0])).toBe(
            "Main booted and this PR did not: The build checks github.com/Masterminds/semver/v3@v3.4.0 against the Go checksum database, which the sandbox does not reach. No path was compared.",
        );
        const older = summaryOf(
            bootRegressionRun({ bootFailure: undefined }),
            [],
        );
        expect(plainText(older.explanation[0])).toBe(
            "Main booted and this PR did not, so no path was compared.",
        );
        expect(plainText(older.todo!.text)).toMatch(/^Boot this PR locally/);
    });
});

describe("pre-existing-only comparison", () => {
    it("explains the neutral result and next action for an exercised path", () => {
        const run = partlyTestedRun();
        run.probes = [
            {
                probeId: "cart-existing",
                entryPoint: "GET /cart",
                verdict: "pre_existing",
                reason: "same failure",
            },
        ];
        run.findings = [];
        run.uncoveredEntryPoints = ["GET /cart"];
        run.uncovered = [{ entryPoint: "GET /cart", reason: "pre_existing" }];
        const summary = summaryOf(run, []);
        expect(summary.headline).toBe(
            "Some paths still have existing failures",
        );
        expect(summary.explanation.map(plainText).join(" ")).toContain(
            "The same failure was observed on both versions",
        );
        expect(plainText(summary.todo!.text)).toContain(
            "Investigate the existing failures",
        );
    });
});

describe("mixed pre-existing and untested paths", () => {
    it("keeps both next steps without saying nothing is needed for the exercised path", () => {
        const run = partlyTestedRun();
        run.probes = [
            {
                probeId: "cart-existing",
                entryPoint: "GET /cart",
                verdict: "pre_existing",
                reason: "same failure",
            },
        ];
        run.findings = [];
        run.uncoveredEntryPoints = ["GET /cart", "POST /orders"];
        run.uncovered = [
            { entryPoint: "GET /cart", reason: "pre_existing" },
            { entryPoint: "POST /orders", reason: "no_probe" },
        ];
        const summary = summaryOf(run, []);
        expect(plainText(summary.todo!.text)).toContain(
            "Investigate the existing failures",
        );
        expect(plainText(summary.todo!.text)).toContain("POST /orders");
        expect(plainText(summary.todo!.text)).not.toContain(
            "Nothing is needed",
        );
    });
});

describe("routes the PR adds (Run 371c8255, demo-shop#4)", () => {
    // POST /orders/preview does not exist on main: 404 there, 200 and 400 on the PR.
    const preview = (
        probeId: string,
        patch: Partial<
            NonNullable<ReturnType<typeof partlyTestedRun>["probes"]>[number]
        > = {},
    ) => ({
        probeId,
        entryPoint: "POST /orders/preview",
        verdict: "new_endpoint" as const,
        reason: "main has no such route (404) and this PR answers it (200): new behavior, not a regression",
        differingFields: ["status", "json"],
        ...patch,
    });
    const kr4 = (
        probes: ReturnType<typeof preview>[],
        state: "no_regressions" | "regression",
    ) =>
        partlyTestedRun({
            state,
            verdictState: state,
            probes,
            findings: probes.filter((p) => p.verdict === "finding"),
            uncoveredEntryPoints: [],
            uncovered: [],
        });
    const pathsOf = (run: ReturnType<typeof partlyTestedRun>) =>
        buildRunPaths(run, []);

    it("a route the PR adds is reported as a new endpoint, not a regression", () => {
        const run = kr4(
            [preview("preview-total"), preview("preview-empty")],
            "no_regressions",
        );
        const paths = pathsOf(run);
        expect(paths.paths.map((p) => p.outcome)).toEqual([
            "new_endpoint",
            "new_endpoint",
        ]);
        expect(coverageRows(paths, run).map((r) => [r.mark, r.label])).toEqual([
            ["new", "New endpoint, not on main"],
            ["new", "New endpoint, not on main"],
        ]);
        expect(runStats(paths, undefined).regressions).toBe(0);
        const text = summaryOf(run).explanation.map(plainText).join(" ");
        expect(summaryOf(run).headline).toBe(
            "No regressions in the recorded comparisons",
        );
        expect(text).toContain(
            "New endpoint this PR adds, which main does not have: POST /orders/preview. New behavior, not a regression.",
        );
    });

    it("a new route that errors in the PR is reported as a finding on the new code", () => {
        const run = kr4(
            [
                preview("preview-total", {
                    verdict: "finding",
                    findingKind: "new_endpoint_error",
                    intent: "unintended",
                    reason: "a route this PR adds answers 502 on the PR; main has no such route (404)",
                }),
            ],
            "regression",
        );
        const paths = pathsOf(run);
        expect(paths.paths[0]).toMatchObject({ outcome: "new_endpoint_error" });
        expect(coverageRows(paths, run)[0]).toMatchObject({
            mark: "regression",
            label: "Error on a new endpoint",
        });
        expect(runStats(paths, undefined).regressions).toBe(1);
        const summary = summaryOf(run);
        expect(summary.headline).toBe("A route this PR adds fails");
        expect(summary.explanation.map(plainText).join(" ")).toContain(
            "not a regression against main",
        );
    });

    it("a route the PR removes still fails as a regression", () => {
        const run = kr4(
            [
                preview("preview", {
                    verdict: "finding",
                    findingKind: "behavior_change",
                    intent: "unintended",
                    reason: "stable base, stable PR, and they differ",
                }),
            ],
            "regression",
        );
        expect(pathsOf(run).paths[0]).toMatchObject({ outcome: "regression" });
        expect(summaryOf(run).headline).not.toBe("A route this PR adds fails");
    });
});

describe("the verdict's one action", () => {
    const repoFetch = {
        ...sumdbBootFailure(),
        signature: "repo_fetch",
        title: "Kodus failed while downloading the repository",
        logTail: [],
        errorLine: undefined,
    };

    it("could not boot on Kodus's side: says it was Kodus, and the action is to run again", () => {
        const s = summaryOf(
            bootFailureRun({
                state: "could_not_boot",
                reason: "platform:repo_fetch",
                bootFailure: repoFetch,
            }),
            [],
        );
        expect(s.headline).toBe("Kodus could not start this Run");
        expect(plainText(s.explanation[0])).toBe(
            "Kodus failed while downloading the repository. The problem is on Kodus's side, not in your repository or its setup file. Nothing was compared.",
        );
        expect(s.todo?.action).toEqual({ kind: "run_again" });
        expect(s.todo?.link).toBeUndefined();
        expect(plainText(s.todo!.text)).toBe(
            "Run again. If it fails the same way, share this Run link with support.",
        );
    });

    it("could not boot in the repository: opens the setup file", () => {
        const s = summaryOf(
            bootFailureRun({
                state: "could_not_boot",
                bootFailure: {
                    ...sumdbBootFailure(),
                    kind: "toolchain",
                    signature: "toolchain:go",
                },
            }),
            [],
        );
        expect(s.headline).toBe("Kody could not boot the app");
        expect(s.todo?.link).toEqual({
            href: "/runtime/environments/env-1#recipe",
            label: "Open the setup file",
        });
        expect(s.todo?.action).toBeUndefined();
    });

    it("a PR that does not boot for a reason on Kodus's side is not the developer's to fix", () => {
        const s = summaryOf(bootRegressionRun(), []);
        expect(plainText(s.todo!.text)).toBe(
            "The boot failed on Kodus's side, not in this PR. Run again; if it fails the same way, share this Run link with support.",
        );
        expect(s.todo?.action).toEqual({ kind: "run_again" });
    });

    it("a new route that answers what the PR expected asks to confirm it is intended", () => {
        const s = summaryOf(newRouteRun(), newRouteView().steps);
        expect(s.headline).toBe(
            "New behavior that matches what this PR says it does",
        );
        expect(plainText(s.explanation[0])).toBe(
            "GET /orders/export answered 200 on this PR, as Kody expected before running; main answered 404 because it has no such route. Confirm it is intended.",
        );
        expect(s.todo?.action).toEqual({
            kind: "mark_intended",
            probeId: "orders-export",
        });
    });

    it("once marked intended, there is nothing left to confirm", () => {
        const s = summaryOf(
            newRouteRun({
                intendedBy: {
                    "orders-export": {
                        userId: "u-1",
                        at: "2026-11-06T18:00:00.000Z",
                        mine: true,
                    },
                },
            }),
            newRouteView().steps,
        );
        expect(s.todo?.action).toBeUndefined();
        expect(plainText(s.todo!.text)).toMatch(/^Marked as intended\./);
    });

    it("a real regression opens its finding, and says how sure Kody is", () => {
        const s = summaryOf(regressionRun(), regressionView().steps);
        expect(s.todo?.action).toEqual({
            kind: "open_finding",
            probeId: "orders-coupon",
        });
        expect(s.certainty).toBe("Same answer in 2 of 2 attempts on each side");
    });

    it("an error or a time limit asks to run again", () => {
        expect(
            summaryOf(partlyTestedRun({ state: "errored" })).todo?.action,
        ).toEqual({ kind: "run_again" });
        expect(
            summaryOf(partlyTestedRun({ state: "timed_out" })).todo?.action,
        ).toEqual({ kind: "run_again" });
    });

    it("explains a wait for a machine instead of looking slow", () => {
        expect(summaryOf(partlyTestedRun({ state: "queued" }))).toMatchObject({
            headline: "Waiting for a free machine",
            explanation: [
                [
                    "The Run is queued until a machine is free. Kody starts as soon as one takes it; nothing has run yet.",
                ],
            ],
        });
    });

    describe("a Run that waits for a host", () => {
        const capacityWait = {
            side: "pr" as const,
            at: "2026-11-17T12:00:00.000Z",
            signature: "no_capacity",
            hosts: 2,
            nextFreeAt: "2026-11-17T12:04:00.000Z",
        };
        it("says while it waits that every host is busy, how many, and when the first frees", () => {
            const s = summaryOf(partlyTestedRun({ state: "booting", phase: "capacity", capacityWait }));
            expect(s.headline).toBe("Waiting for a host");
            expect(plainText(s.explanation[0]!)).toBe(
                "All 2 hosts that can run this environment are busy; the first frees in 4 min at the latest. Kody starts as soon as one has room; nothing has run yet.",
            );
        });
        it("says the wait ended the Run when it timed out waiting, with the same numbers", () => {
            const s = summaryOf(
                partlyTestedRun({
                    state: "timed_out",
                    capacityWait,
                    bootFailure: { side: "pr", kind: "resources", signature: "no_capacity", title: "Every host that can run this environment is full", logTail: [], at: "2026-11-17T12:30:00.000Z" },
                }),
            );
            expect(s.headline).toBe("No host had room for this Run");
            expect(plainText(s.explanation[0]!)).toBe(
                "It waited for a host and none had room. All 2 hosts that can run this environment are busy; the first frees in 4 min at the latest.",
            );
            expect(s.todo?.action).toEqual({ kind: "run_again" });
        });
        it("keeps an older timed out Run without a capacity card as before", () => {
            expect(summaryOf(partlyTestedRun({ state: "timed_out" })).headline).toBe(
                "This Run hit its time limit before a verdict",
            );
        });
    });
});
