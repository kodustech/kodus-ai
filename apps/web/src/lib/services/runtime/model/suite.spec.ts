import type {
    RuntimeEnvironmentSuite,
    RuntimeSuiteFailure,
    RuntimeSuiteRun,
} from "../contracts";
import {
    artifactLabel,
    attemptsLine,
    environmentSuiteFacts,
    failureGroups,
    mainLine,
    selectionBanner,
    specCounts,
    specRows,
    suiteFacts,
    suiteTimeSplit,
    suiteUsageLines,
    suiteVerdict,
    whySpecs,
} from "./suite";

const MAIN = "a41c0d3".padEnd(40, "0");
const failure = (
    over: Partial<RuntimeSuiteFailure> = {},
): RuntimeSuiteFailure => ({
    spec: "e2e/checkout.spec.ts",
    title: "applies a discount code",
    group: "regression",
    detail: "regression",
    pr: { attempts: 2, failed: 2 },
    main: { sha: MAIN, outcome: "passed", sameError: false },
    reachedBy: ["src/routes/cart.js"],
    artifacts: [],
    ...over,
});
const run = (over: Partial<RuntimeSuiteRun> = {}): RuntimeSuiteRun => ({
    suiteRunId: "sr-1",
    environmentId: "env-1",
    mode: "run",
    state: "failed",
    requestedAt: "2026-11-24T10:00:00.000Z",
    finishedAt: "2026-11-24T10:06:12.000Z",
    durationMs: 372_000,
    prNumber: 41,
    mainSha: MAIN,
    baseDrift: 2,
    selection: {
        mode: "selected",
        selected: 9,
        total: 24,
        reachedBy: {
            "src/routes/cart.js": ["checkout.spec.ts", "cart.spec.ts"],
            "src/lib/price.js": ["catalog.spec.ts"],
        },
    },
    specs: { ran: 9, total: 24 },
    totals: { passed: 6, failed: 3, skipped: 0, notRun: 0 },
    classes: { regression: 1, preExisting: 1, flaky: 1, unclassified: 0 },
    machine: { firstPassMs: 11 * 60_000, rerunMs: 3 * 60_000 },
    hosts: 2,
    shards: [],
    specRows: [],
    hostTimes: [],
    failures: [
        failure(),
        failure({
            spec: "e2e/catalog.spec.ts",
            title: "lists products by price",
            group: "pre_existing",
            detail: "pre_existing",
            main: { sha: MAIN, outcome: "failed", sameError: true },
            reachedBy: [],
        }),
        failure({
            spec: "e2e/order.spec.ts",
            title: "shows the order confirmation",
            group: "flaky",
            detail: "flaky",
            pr: { attempts: 2, failed: 1 },
            main: undefined,
            reachedBy: [],
        }),
    ],
    passed: [],
    canRetry: true,
    ...over,
});

describe("the verdict banner, written from the structured fields", () => {
    it("names the one regression, how many times it failed, and says what does not block", () => {
        expect(suiteVerdict(run())).toEqual({
            tone: "danger",
            title: "1 regression, the check failed",
            sentence:
                "checkout.spec.ts › applies a discount code passes on main and fails on this PR, twice. 1 test was already failing on main and 1 is flaky; neither blocks.",
        });
    });

    it("counts several regressions instead of naming them", () => {
        const v = suiteVerdict(
            run({
                classes: {
                    regression: 3,
                    preExisting: 0,
                    flaky: 0,
                    unclassified: 0,
                },
                failures: [
                    failure(),
                    failure({ title: "b" }),
                    failure({ title: "c" }),
                ],
            }),
        );
        expect(v.title).toBe("3 regressions, the check failed");
        expect(v.sentence).toBe("3 tests pass on main and fail on this PR.");
    });

    it("a regression with no main run says only that it fails on this PR", () => {
        const v = suiteVerdict(
            run({
                failures: [failure({ main: undefined })],
                classes: {
                    regression: 1,
                    preExisting: 0,
                    flaky: 0,
                    unclassified: 0,
                },
            }),
        );
        expect(v.sentence).toBe(
            "checkout.spec.ts › applies a discount code fails on this PR, twice.",
        );
    });

    it("failures that could not be classified are neutral unless the gate made the check fail", () => {
        const unclassified = {
            classes: {
                regression: 0,
                preExisting: 0,
                flaky: 0,
                unclassified: 2,
            },
            failures: [],
        };
        expect(
            suiteVerdict(run({ ...unclassified, state: "neutral" })),
        ).toMatchObject({
            tone: "warning",
            title: "2 failures could not be classified, the check is neutral",
        });
        expect(
            suiteVerdict(run({ ...unclassified, state: "failed" })),
        ).toMatchObject({
            tone: "danger",
            title: "2 failures could not be classified, the check failed",
        });
    });

    it("a green run says how many specs passed, and what noise did not block", () => {
        const v = suiteVerdict(
            run({
                state: "passed",
                classes: {
                    regression: 0,
                    preExisting: 0,
                    flaky: 1,
                    unclassified: 0,
                },
                totals: { passed: 8, failed: 0, skipped: 0, notRun: 0 },
            }),
        );
        expect(v).toEqual({
            tone: "success",
            title: "No regressions, 8 specs passed",
            sentence: "1 test is flaky; it does not block.",
        });
    });

    it.each([
        ["requested", "info", "Running"],
        ["running", "info", "Running"],
        ["timed_out", "warning", "Timed out"],
        ["cancelled", "neutral", "Cancelled"],
        ["errored", "danger", "Could not finish"],
    ] as const)("a %s run is %s: %s", (state, tone, title) => {
        expect(
            suiteVerdict(
                run({
                    state,
                    finishedAt: undefined,
                    classes: {
                        regression: 0,
                        preExisting: 0,
                        flaky: 0,
                        unclassified: 0,
                    },
                    failures: [],
                }),
            ),
        ).toMatchObject({ tone, title });
    });
});

describe("the four key facts", () => {
    it("says how many specs ran of how many, and why", () => {
        const [specs] = suiteFacts(run());
        expect(specs).toEqual({
            label: "Specs run",
            value: "9 of 24",
            hint: "Selected by coverage of the diff",
        });
        const full = suiteFacts(
            run({
                specs: { ran: 24, total: 24 },
                selection: { mode: "full", reason: "lockfile", total: 24 },
            }),
        )[0];
        expect(full).toEqual({
            label: "Specs run",
            value: "24 of 24",
            hint: "The whole suite ran: a lockfile changed",
        });
        expect(
            suiteFacts(
                run({
                    specs: { ran: 0, total: 24 },
                    selection: { mode: "none", total: 24 },
                }),
            )[0].hint,
        ).toBe("No spec is reached by this change");
    });

    it("says the duration with its shards and hosts", () => {
        expect(suiteFacts(run())[1]).toEqual({
            label: "Duration",
            value: "6 min 12 s",
            hint: "2 hosts, one shard each",
        });
        expect(suiteFacts(run({ hosts: 1 }))[1].hint).toBe("1 host");
    });

    it("says which main it was compared against and how far behind the merge base is", () => {
        expect(suiteFacts(run())[2]).toEqual({
            label: "Compared against",
            value: "main a41c0d3",
            hint: "Merge base, 2 commits behind main",
            mono: true,
        });
        expect(suiteFacts(run({ baseDrift: 1 }))[2].hint).toBe(
            "Merge base, 1 commit behind main",
        );
        expect(suiteFacts(run({ baseDrift: 0 }))[2].hint).toBe(
            "Merge base is main",
        );
        expect(suiteFacts(run({ baseDrift: undefined }))[2].hint).toBe(
            "How far behind main was not compared",
        );
    });

    it("splits the machine time into the first pass and the re-runs, and says when it was not recorded", () => {
        expect(suiteFacts(run())[3]).toEqual({
            label: "Machine time",
            value: "14 min",
            hint: "First pass 11 · re-runs 3",
        });
        expect(suiteFacts(run({ machine: undefined }))[3]).toEqual({
            label: "Machine time",
            value: "Not recorded",
            hint: "This run was stored before machine time was measured",
        });
    });

    // A run still in flight has no machine time yet; saying it was stored before measuring would be false.
    it("says the machine time is measured when the suite ends while the run is still going", () => {
        for (const state of ["requested", "running"] as const)
            expect(suiteFacts(run({ state, machine: undefined }))[3]).toEqual({
                label: "Machine time",
                value: "Measured when the suite ends",
                hint: "The suite is still running",
            });
    });
});

describe("the failed tests", () => {
    it("are grouped Regression, Unclassified, Already failing on main, Flaky, and a group with none is not shown", () => {
        const groups = failureGroups(run());
        expect(groups.map((g) => [g.label, g.items.length])).toEqual([
            ["Regression", 1],
            ["Already failing on main", 1],
            ["Flaky", 1],
        ]);
        expect(groups[0].tone).toBe("danger");
        const withUnclassified = failureGroups(
            run({
                failures: [failure({ group: "unclassified", detail: "infra" })],
            }),
        );
        expect(withUnclassified.map((g) => g.label)).toEqual(["Unclassified"]);
    });

    it("says the PR's tries and what main said", () => {
        expect(attemptsLine({ attempts: 2, failed: 2 })).toBe("failed 2 of 2");
        expect(attemptsLine({ attempts: 2, failed: 1 })).toBe("failed 1 of 2");
        expect(attemptsLine({ attempts: 0, failed: 0 })).toBe(
            "no attempt recorded",
        );
        expect(mainLine(failure())).toBe("passed");
        expect(
            mainLine(
                failure({
                    main: { sha: MAIN, outcome: "failed", sameError: true },
                }),
            ),
        ).toBe("failed, the same error");
        expect(
            mainLine(
                failure({
                    main: { sha: MAIN, outcome: "failed", sameError: false },
                }),
            ),
        ).toBe("failed, with another error");
        expect(
            mainLine(
                failure({
                    main: { sha: MAIN, outcome: "not_run", sameError: false },
                }),
            ),
        ).toBe("not run");
        expect(mainLine(failure({ main: undefined }))).toBe(
            "not run for this test",
        );
    });

    it("names an artifact by what it is", () => {
        expect(artifactLabel("trace.zip")).toBe("Trace");
        expect(artifactLabel("login-failed.png")).toBe("Screenshot");
        expect(artifactLabel("login-failed.webm")).toBe("Video");
        expect(artifactLabel("shard-0.log")).toBe("Log tail");
        expect(artifactLabel("report.json")).toBe("report.json");
    });
});

describe("why these specs", () => {
    it("lists, per changed file, the specs it reaches", () => {
        expect(whySpecs(run())).toEqual({
            title: "Why these 9 specs",
            summary: "picked from 2 changed files",
            rows: [
                {
                    file: "src/routes/cart.js",
                    specs: "checkout.spec.ts, cart.spec.ts",
                },
                { file: "src/lib/price.js", specs: "catalog.spec.ts" },
            ],
            note: "Usually Kody runs only the specs a change can affect, from what full runs on main taught it about which code each spec exercises. It runs every spec when dependencies or test configuration change, when it has not learned that yet, or right after it caught a spec it should have run.",
        });
    });

    it("gives the reason when the whole suite ran, and never an invented map when the run did not store one", () => {
        const full = whySpecs(
            run({
                specs: { ran: 24, total: 24 },
                selection: { mode: "full", reason: "manifest", total: 24 },
            }),
        );
        expect(full.title).toBe("Why all 24 specs");
        expect(full.summary).toBe("a dependency manifest changed");
        expect(full.rows).toEqual([]);
        const noMap = whySpecs(
            run({ selection: { mode: "selected", selected: 9, total: 24 } }),
        );
        expect(noMap.rows).toEqual([]);
        expect(noMap.summary).toBe(
            "which changed file reached which spec was not recorded for this run",
        );
    });
});

describe("the environment settings: facts and the paused banner", () => {
    const env = (
        over: Partial<RuntimeEnvironmentSuite> = {},
    ): RuntimeEnvironmentSuite => ({
        environmentId: "env-1",
        recipe: {
            runner: "playwright",
            specs: "e2e/**/*.spec.ts",
            command: "npx playwright test {specs}",
            results: "results/*.xml",
            shards: 3,
            gate: "default",
            baseline: true,
        },
        lastBaseline: {
            sha: MAIN,
            specs: 24,
            passed: 22,
            failed: 2,
            finishedAt: "2026-11-24T14:02:00.000Z",
        },
        selection: { enabled: true },
        ci: { enabled: false, source: "deployment" },
        ...over,
    });

    it("reads the recipe's facts, with the spec count from the last baseline and the shard ceiling and gate as the recipe's own", () => {
        const f = environmentSuiteFacts(env());
        expect(f.map((x) => [x.label, x.value])).toEqual([
            ["Runner", "Playwright"],
            ["Specs", "e2e/**/*.spec.ts · 24 files"],
            ["Command", "npx playwright test {specs}"],
            ["Results", "results/*.xml"],
            ["Last baseline on main", "a41c0d3 · 22 passed, 2 failed"],
            ["Maximum hosts per run", "3"],
            [
                "When a failure cannot be classified",
                "Neutral: only a confirmed regression fails the check",
            ],
        ]);
        expect(
            environmentSuiteFacts(
                env({
                    recipe: {
                        ...env().recipe!,
                        gate: "strict",
                        shards: undefined,
                    },
                    lastBaseline: undefined,
                }),
            ).map((x) => x.value),
        ).toEqual([
            "Playwright",
            "e2e/**/*.spec.ts",
            "npx playwright test {specs}",
            "results/*.xml",
            "Waiting for the main template to be built",
            "Up to the recipe's default",
            "Strict: anything unconfirmed fails the check too",
        ]);
    });

    it("says why there is no baseline: waiting for the main template, queued, running, no suite at that commit, or replaced by a newer commit", () => {
        const text = (baselineRequest: any) =>
            environmentSuiteFacts(env({ lastBaseline: undefined, baselineRequest })).find((x) => x.label === "Last baseline on main")!.value;
        expect(text(undefined)).toBe("Waiting for the main template to be built");
        expect(text({ sha: MAIN, state: "queued" })).toBe(`Queued for ${MAIN.slice(0, 7)}, not started yet`);
        expect(text({ sha: MAIN, state: "started" })).toBe(`Running on ${MAIN.slice(0, 7)}`);
        expect(text({ sha: MAIN, state: "skipped", reason: "no_suite" })).toBe(`No suite declared at ${MAIN.slice(0, 7)}, so no baseline ran`);
        expect(text({ sha: MAIN, state: "superseded", reason: "superseded" })).toBe(`${MAIN.slice(0, 7)} was replaced by a newer main commit before it ran`);
    });

    it("tells a pause by the shadow check, with the PR and the spec it missed", () => {
        expect(selectionBanner({ enabled: true })).toBeUndefined();
        expect(
            selectionBanner({
                enabled: true,
                brake: {
                    off: false,
                    fullPrsLeft: 8,
                    miss: { prNumber: 38, specs: ["e2e/search.spec.ts"] },
                },
            }),
        ).toEqual({
            title: "Spec selection is paused for the next 8 pull requests",
            body: "The shadow check ran the whole suite for PR #38 and found a failure the selection had skipped (e2e/search.spec.ts). Until then every pull request runs the whole suite.",
        });
        expect(
            selectionBanner({
                enabled: true,
                brake: { off: true, fullPrsLeft: 10 },
            }),
        ).toEqual({
            title: "Spec selection is paused until you resume it",
            body: "The shadow check found failures the selection had skipped. Until you resume it, every pull request runs the whole suite.",
        });
        expect(
            selectionBanner({
                enabled: true,
                brake: { off: false, fullPrsLeft: 1 },
            })?.title,
        ).toBe("Spec selection is paused for the next pull request");
    });
});

describe("the usage lines", () => {
    it("names each kind, its runs and machine minutes, and totals what was measured", () => {
        const u = suiteUsageLines({
            lines: [
                { kind: "pr", runs: 212, minutes: 1140 },
                { kind: "baseline", runs: 31, minutes: 390 },
                { kind: "rerun", runs: 64, minutes: 150 },
                { kind: "shadow", runs: 9, minutes: null },
            ],
            unmeasuredRuns: 2,
            saved: { minutes: 520, shadowedRuns: 9 },
        });
        expect(u.rows.map((r) => [r.label, r.what, r.runs, r.minutes])).toEqual(
            [
                ["PR", "First pass on each pull request", "212", "1,140"],
                ["Baseline", "Whole suite on main, with coverage", "31", "390"],
                [
                    "Re-run",
                    "Failed specs again, on the PR and on main",
                    "64",
                    "150",
                ],
                [
                    "Shadow",
                    "Whole suite in the background to check selection",
                    "9",
                    "Not measured",
                ],
            ],
        );
        expect(u.totalMinutes).toBe(1680);
        expect(u.saved).toBe(
            "In the 9 selected runs a full shadow run also covered, selection saved 520 minutes.",
        );
        expect(u.caveat).toBe(
            "2 runs were stored before machine time was measured; their minutes are not here.",
        );
    });

    it("has no savings sentence when none could be measured, and no total when no line has minutes", () => {
        const u = suiteUsageLines({
            lines: [{ kind: "pr", runs: 3, minutes: null }],
            unmeasuredRuns: 0,
        });
        expect(u.saved).toBeUndefined();
        expect(u.totalMinutes).toBeUndefined();
        expect(u.caveat).toBeUndefined();
    });
});

// Where the time went and the specs table (the tab's top half), from a run shaped like kr-shop #49 on dev.
describe("where a suite run's time went", () => {
    const timed = run({
        requestedAt: "2026-11-24T18:14:42.000Z",
        finishedAt: "2026-11-24T18:18:09.000Z",
        shards: [
            {
                shard: 0,
                specs: 5,
                passed: 5,
                failed: 0,
                notRun: 0,
                specMs: 228,
            },
            {
                shard: 1,
                specs: 4,
                passed: 4,
                failed: 0,
                notRun: 0,
                specMs: 320,
            },
        ],
        hostTimes: [
            {
                shard: 61,
                role: "list",
                requestedAt: "2026-11-24T18:15:49.000Z",
                readyAt: "2026-11-24T18:16:10.000Z",
            },
            {
                shard: 0,
                role: "shard",
                requestedAt: "2026-11-24T18:16:49.000Z",
                readyAt: "2026-11-24T18:17:05.000Z",
                startedAt: "2026-11-24T18:17:40.000Z",
                finishedAt: "2026-11-24T18:18:02.000Z",
            },
            {
                shard: 1,
                role: "shard",
                requestedAt: "2026-11-24T18:16:49.000Z",
                readyAt: "2026-11-24T18:17:10.000Z",
                startedAt: "2026-11-24T18:17:45.000Z",
                finishedAt: "2026-11-24T18:18:05.000Z",
            },
        ],
    });

    it("splits the wall time along the host that finished last, and the parts add up to the whole", () => {
        const split = suiteTimeSplit(timed)!;
        expect(
            split.segments.map((s) => [s.key, Math.round(s.ms / 1000)]),
        ).toEqual([
            ["start", 67],
            ["list", 60],
            ["boot", 21],
            ["setup", 35],
            ["specs", 20],
            ["results", 4],
        ]);
        expect(split.segments.reduce((n, s) => n + s.ms, 0)).toBe(
            split.totalMs,
        );
        expect(split.complete).toBe(true);
        expect(
            split.hosts.map((h) => [h.label, h.specs, h.bootMs, h.specsMs]),
        ).toEqual([
            ["Host 1", 5, 16_000, 22_000],
            ["Host 2", 4, 21_000, 20_000],
        ]);
    });

    it("a run whose shards never recorded their start says one last part for what it cannot tell apart", () => {
        const split = suiteTimeSplit(
            run({
                ...timed,
                hostTimes: timed.hostTimes.map(
                    ({ startedAt: _s, finishedAt: _f, ...h }) => h,
                ),
            }),
        )!;
        expect(split.complete).toBe(false);
        expect(split.segments.at(-1)).toMatchObject({
            key: "rest",
            label: "App, specs and results",
        });
    });

    it("says nothing for a run with no host moments", () => {
        expect(suiteTimeSplit(run())).toBeNull();
    });
});

describe("the specs table", () => {
    const rows = run({
        specRows: [
            {
                spec: "e2e/a.spec.js",
                shard: 0,
                result: "passed",
                durationMs: 50,
                tests: [],
                artifacts: [],
            },
            {
                spec: "e2e/slow.spec.js",
                shard: 1,
                result: "passed",
                durationMs: 900,
                tests: [
                    {
                        title: "checks out",
                        status: "passed",
                        attempts: ["passed"],
                    },
                ],
                artifacts: [],
            },
            {
                spec: "e2e/retry.spec.js",
                shard: 0,
                result: "flaky",
                durationMs: 70,
                tests: [],
                artifacts: [],
            },
            {
                spec: "e2e/cart.spec.js",
                shard: 1,
                result: "failed",
                group: "regression",
                durationMs: 30,
                tests: [],
                artifacts: ["trace.zip"],
            },
        ],
    });

    it("puts failures first, then flaky, then the slowest of the rest", () => {
        expect(specRows(rows, "all", "").map((r) => r.spec)).toEqual([
            "e2e/cart.spec.js",
            "e2e/retry.spec.js",
            "e2e/slow.spec.js",
            "e2e/a.spec.js",
        ]);
    });

    it("filters by result and finds a spec by a test's title", () => {
        expect(specCounts(rows)).toEqual({
            all: 4,
            failed: 1,
            flaky: 1,
            passed: 2,
            skipped: 0,
        });
        expect(specRows(rows, "passed", "").map((r) => r.spec)).toEqual([
            "e2e/slow.spec.js",
            "e2e/a.spec.js",
        ]);
        expect(specRows(rows, "all", "checks OUT").map((r) => r.spec)).toEqual([
            "e2e/slow.spec.js",
        ]);
    });
});
