import {
    partlyTestedRun,
    partlyTestedView,
    regressionRun,
    regressionView,
} from "./__fixtures__/run-detail";
import {
    buildRunLog,
    filterRunLog,
    initiallyOpen,
    runLogText,
    stepResult,
} from "./run-log";
import { buildRunPaths } from "./run-paths";
import { runTiming } from "./run-timing";

const logOf = (run = partlyTestedRun(), view = partlyTestedView()) =>
    buildRunLog(
        run,
        view,
        buildRunPaths(run, view.steps),
        runTiming(run, view),
    );

describe("buildRunLog", () => {
    it.each(["release/2026", undefined])(
        "names the base version in phase titles, readiness and step sides (%j)",
        (baseBranch) => {
            const run = partlyTestedRun({ baseBranch });
            const label = baseBranch || "base version";
            const groups = logOf(run, partlyTestedView());
            expect(groups.find((g) => g.id === "boot")?.title).toBe(
                `Boot ${label}`,
            );
            expect(groups.find((g) => g.id === "test")?.title).toBe(
                `Compare ${label} and this PR`,
            );
            const lines = groups.flatMap((g) => g.lines);
            expect(lines.find((l) => l.id === "main-ready")?.text).toBe(
                `${label} is ready`,
            );
            expect(lines.find((l) => l.id === "explore-e1")?.side).toBe(label);
        },
    );

    it.each([
        { uncoveredEntryPoints: undefined, status: "warn" },
        { uncoveredEntryPoints: [], status: "ok" },
    ] as const)(
        "distinguishes missing coverage from an explicitly complete record ($status) after the stream expires",
        ({ uncoveredEntryPoints, status }) => {
            const run = partlyTestedRun({
                state: "no_regressions",
                uncoveredEntryPoints: uncoveredEntryPoints && [
                    ...uncoveredEntryPoints,
                ],
                exploration: [],
                publication: undefined,
            });
            const view = {
                ...partlyTestedView(),
                states: [],
                phases: [],
                steps: [],
                published: [],
                verdict: undefined,
            };
            const comparison = logOf(run, view).find(
                (group) => group.id === "test",
            )!;
            expect(comparison.status).toBe(status);
            expect(comparison.note).toContain("1 comparison recorded");
            expect(
                comparison.lines.some(
                    (line) => line.id === "comparison-coverage-unknown",
                ),
            ).toBe(uncoveredEntryPoints === undefined);
        },
    );

    it("retains the projected terminal failure when all stream events expired without exposing its legacy diagnostics", () => {
        const run = partlyTestedRun({
            state: "errored",
            probes: [],
            findings: [],
            exploration: [],
            publication: undefined,
            reason: "Authorization: Bearer synthetic-private-token",
        });
        const view = {
            ...partlyTestedView(),
            states: [],
            phases: [],
            steps: [],
            published: [],
            verdict: undefined,
        };
        const groups = logOf(run, view);
        const report = groups.find((group) => group.id === "report")!;
        expect(report).toBeDefined();
        expect(report.status).toBe("warn");
        expect(
            filterRunLog(groups, { onlyFailures: true }).flatMap(
                (group) => group.lines,
            ),
        ).toContainEqual(
            expect.objectContaining({
                id: "terminal",
                at: run.finishedAt,
                text: "state could not finish",
                attention: true,
            }),
        );
        expect(runLogText(groups)).not.toContain("synthetic-private-token");
    });

    it.each([
        { status: "pending" as const },
        { status: "pending" as const, retrying: true },
        { status: "published" as const, fallback: true },
    ])(
        "retains publication warnings in Needs attention when comparison coverage is complete (%j)",
        (comment) => {
            const run = partlyTestedRun({
                state: "no_regressions",
                uncoveredEntryPoints: [],
                exploration: [],
                publication: {
                    postsToPullRequest: true,
                    check: { status: "published" },
                    comment,
                    settled: false,
                },
            });
            const view = {
                ...partlyTestedView(),
                states: [],
                phases: [],
                steps: [],
                published: [],
                verdict: undefined,
            };
            const groups = logOf(run, view);
            expect(groups.find((group) => group.id === "test")?.status).toBe(
                "ok",
            );
            expect(
                filterRunLog(groups, { onlyFailures: true }).flatMap(
                    (group) => group.lines,
                ),
            ).toContainEqual(
                expect.objectContaining({
                    id: "publication-comment",
                    attention: true,
                }),
            );
        },
    );

    it("does not turn planned checks and successful readiness into a completed behavioral comparison", () => {
        const run = partlyTestedRun({
            state: "errored",
            probes: [],
            findings: [],
            exploration: [],
            uncoveredEntryPoints: ["POST /orders"],
        });
        const at = "2026-11-09T21:57:19.501Z";
        const view = {
            ...partlyTestedView(),
            verdict: undefined,
            states: [
                { state: "testing" as const, at },
                { state: "errored" as const, at },
            ],
            phases: [{ phase: "replay", at, counts: { probes: 3 } }],
            steps: [
                {
                    stepId: "reset",
                    kind: "machine.reset",
                    side: "base",
                    startedAt: at,
                    finishedAt: at,
                },
                {
                    stepId: "ready",
                    kind: "probe.run",
                    probeId: "run-ready",
                    side: "base",
                    status: 200,
                    startedAt: at,
                    finishedAt: at,
                },
            ],
        };
        const groups = logOf(run, view);
        const comparison = groups.find((group) => group.id === "test")!;
        expect(comparison.status).toBe("warn");
        expect(comparison.note).toContain("3 checks planned");
        expect(comparison.note).toContain("No comparison recorded");
        expect(
            comparison.lines.find((line) => line.id === "step-ready")?.text,
        ).toBe("app readiness check");
        const attention = filterRunLog(groups, { onlyFailures: true });
        expect(
            attention
                .flatMap((group) => group.lines)
                .some((line) => line.id === "terminal"),
        ).toBe(true);
        expect(
            attention
                .flatMap((group) => group.lines)
                .some((line) => line.id === "comparison-missing"),
        ).toBe(true);
    });

    it("omits a legacy internal error reason while retaining the terminal state and time", () => {
        const run = partlyTestedRun({ state: "errored" });
        const at = "2026-11-09T21:57:19.501Z";
        const reason =
            "hub400 http://host.orb.internal:3420/upload?token=synthetic-private&signature=synthetic-signature Authorization: Bearer synthetic-bearer SQL SELECT synthetic-query pattern ^https?://[^.]+$";
        const view = {
            ...partlyTestedView(),
            states: [{ state: "errored" as const, at, reason }],
        };
        const groups = logOf(run, view);
        const terminal = groups
            .find((group) => group.id === "report")!
            .lines.find((line) => line.id === "terminal");
        expect(terminal?.at).toBe(at);
        expect(terminal?.text).toBe("state could not finish");
        const text = runLogText(groups);
        expect(text).not.toContain("host.orb.internal");
        expect(text).not.toContain("synthetic-private");
        expect(text).not.toContain("synthetic-signature");
        expect(text).not.toContain("synthetic-bearer");
        expect(text).not.toContain("synthetic-query");
        expect(view.states[0]).toEqual({ state: "errored", at, reason });
        expect(text).not.toContain("^https?");
    });

    it("retains the reason for other terminal states", () => {
        const view = {
            ...partlyTestedView(),
            states: [
                {
                    state: "skipped" as const,
                    at: "2026-11-09T21:57:19.501Z",
                    reason: "budget reached",
                },
            ],
        };
        const terminal = logOf(partlyTestedRun({ state: "skipped" }), view)
            .find((group) => group.id === "report")!
            .lines.find((line) => line.id === "terminal");
        expect(terminal?.text).toBe("state skipped · budget reached");
    });

    it("groups the Run by phase with each phase's duration", () => {
        const groups = logOf();
        expect(groups.map((g) => [g.id, g.status, g.durationMs])).toEqual([
            ["boot", "ok", 14_000],
            ["apply", "ok", 471_000],
            ["explore", "failed", 325],
            ["test", "warn", 68_000],
            ["report", "warn", 3_000],
        ]);
        expect(groups[2].note).toBe("2 of 2 commands failed");
    });

    it("shows the PR's build counts and slowest steps in the build group", () => {
        const apply = logOf().find((g) => g.id === "apply")!;
        expect(apply.lines.map((l) => l.text)).toEqual([
            "build · 12 steps · 9 cached",
            "app · RUN make build-go",
            "app · load build context",
            "this PR is built and ready",
        ]);
        expect(apply.lines[1].durationMs).toBe(400_000);
    });

    it("each explored command is a $ line with its exit or error and its evidence on main", () => {
        const explore = logOf().find((g) => g.id === "explore")!;
        const [cmd1, cmd2] = explore.lines.filter((l) => l.command);
        expect(cmd1).toMatchObject({
            command: "cd /app/workspace && ls",
            result: { text: "exit 127", tone: "fail" },
            failed: true,
            evidence: { stepId: "e1", side: "base" },
        });
        expect(cmd2.result).toEqual({ text: "exec timeout", tone: "fail" });
        // An explored step is not repeated in the test group.
        expect(
            logOf()
                .find((g) => g.id === "test")!
                .lines.some((l) => l.id === "step-e1"),
        ).toBe(false);
    });

    it("every test step keeps its evidence key, and the path verdicts follow", () => {
        const test = logOf().find((g) => g.id === "test")!;
        expect(test.lines.find((l) => l.id === "step-p1")).toMatchObject({
            side: "pr",
            text: "check health",
            result: { text: "200", tone: "ok" },
            evidence: { stepId: "p1", side: "pr" },
        });
        expect(
            test.lines.find((line) => line.id === "path-health-GET /api/health")
                ?.text,
        ).toBe("GET /api/health: Same on both versions");
        expect(test.lines.at(-1)?.text).toBe(
            "1 changed path has no recorded comparison.",
        );
    });

    it("the report says what reached the PR, retries included", () => {
        const report = logOf().find((g) => g.id === "report")!;
        expect(report.lines.map((l) => l.text)).toEqual([
            "verdict partly tested · 1 of 2 paths",
            "state partly tested",
            "check → on the pull request",
            "comment → retrying · The last delivery failed; Kodus is retrying (retry 1).",
        ]);
    });

    it("a simulation says it posts nothing", () => {
        const run = partlyTestedRun({
            publication: {
                ...partlyTestedRun().publication!,
                postsToPullRequest: false,
            },
        });
        const report = logOf(run).find((g) => g.id === "report")!;
        expect(report.title).toBe("Report");
        expect(report.lines.at(-1)?.text).toMatch(/^simulation/);
    });

    it("a boot that failed lands in its group, open", () => {
        const run = partlyTestedRun({
            state: "could_not_boot",
            phaseMs: undefined,
            reason: "base not ready",
            exploration: [],
        });
        const view = {
            ...partlyTestedView(),
            states: partlyTestedView().states.slice(0, 2),
            steps: [],
            phases: [],
            verdict: undefined,
        };
        const groups = buildRunLog(
            run,
            view,
            buildRunPaths({}, []),
            runTiming(run, view),
        );
        expect(groups[0]).toMatchObject({ id: "boot", status: "failed" });
        expect(groups[0].lines.at(-1)?.text).toBe(
            "could not boot: base not ready",
        );
        expect(initiallyOpen(groups)).toEqual(new Set(["boot"]));
    });

    it("marks a lost, refused or timed-out step as failed", () => {
        expect(
            stepResult({ stepId: "s", finishedAt: "t", outcome: "timeout" }),
        ).toEqual({
            text: "timed out",
            tone: "fail",
            failed: true,
        });
        expect(
            stepResult({ stepId: "s", finishedAt: "t", transport: "lost" })
                .failed,
        ).toBe(true);
        expect(stepResult({ stepId: "s" })).toMatchObject({
            text: "running",
            failed: false,
        });
        expect(
            stepResult({ stepId: "s", finishedAt: "t", status: 500 }).tone,
        ).toBe("fail");
    });
});

describe("filterRunLog and runLogText", () => {
    it("needs attention retains failures, incomplete comparisons and the terminal limitation", () => {
        const shown = filterRunLog(logOf(), { onlyFailures: true });
        expect(shown.map((g) => g.id)).toEqual(["explore", "test", "report"]);
        expect(shown[0].lines).toHaveLength(2);
    });

    it("searches lines, results and sides, case-insensitive", () => {
        const shown = filterRunLog(logOf(regressionRun(), regressionView()), {
            query: "500",
        });
        expect(shown.flatMap((g) => g.lines.map((l) => l.id))).toEqual([
            "step-rp1",
            "step-rp2",
        ]);
        expect(filterRunLog(logOf(), { query: "  " })).toEqual(logOf());
    });

    it("writes the plain log with the UTC clock, or without it", () => {
        const text = runLogText(logOf());
        expect(text).toContain(
            "! Explore the app on main · 2 of 2 commands failed (325 ms)",
        );
        expect(text).toContain(
            "18:14:27 main $ cd /app/workspace && ls → exit 127 · 325 ms",
        );
        expect(runLogText(logOf(), { timestamps: false })).not.toMatch(
            /\d\d:\d\d:\d\d main/,
        );
    });
});
