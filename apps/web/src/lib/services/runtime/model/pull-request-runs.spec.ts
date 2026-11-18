import {
    livePhaseLabel,
    buildCommitTimeline,
    cannotRequestRunReason,
    canRequestRun,
    environmentNameOf,
    failureWords,
    fieldWords,
    mainRunOf,
    otherEnvironmentsOf,
    otherEnvironmentWords,
    prRuntimeCell,
    regressionSentence,
    requestRunRepositoryIds,
    runtimeFilterOf,
    runVerdictWords,
    staleRunSha,
    valueWords,
    type PrRuntime,
    type PrRuntimeEnvironment,
    type PrRunView,
} from "./pull-request-runs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

const run = (patch: Partial<PrRunView> = {}): PrRunView => ({
    runId: "run-1",
    attempt: 1,
    headSha: SHA_A,
    environmentId: "env-1",
    state: "no_regressions",
    requestedAt: "2026-11-10T10:00:00.000Z",
    regressions: 0,
    probes: 4,
    ...patch,
});

const runtime = (patch: Partial<PrRuntime> = {}): PrRuntime => ({
    repositoryId: "repo-1",
    prNumber: 7,
    environment: {
        environmentId: "env-1",
        name: "acme/shop",
        ready: true,
        on: true,
    },
    latest: null,
    commits: [],
    ...patch,
});

describe("the Runtime column of a PR", () => {
    it("says each verdict of the latest Run", () => {
        expect(
            prRuntimeCell(
                runtime({
                    latest: run({ state: "regression", regressions: 2 }),
                }),
            ),
        ).toEqual({ kind: "regression", count: 2, runId: "run-1" });
        expect(prRuntimeCell(runtime({ latest: run() }))).toEqual({
            kind: "clean",
            probes: 4,
            runId: "run-1",
        });
        expect(
            prRuntimeCell(
                runtime({
                    latest: run({ state: "booting", phase: "capacity" }),
                }),
            ),
        ).toMatchObject({ kind: "running", label: "waiting for a host" });
        expect(
            prRuntimeCell(
                runtime({
                    latest: run({
                        state: "could_not_boot",
                        bootFailureSide: "base",
                    }),
                }),
            ),
        ).toMatchObject({ kind: "could_not_boot", where: "environment" });
        expect(
            prRuntimeCell(
                runtime({
                    latest: run({
                        state: "could_not_boot",
                        bootFailureSide: "pr",
                    }),
                }),
            ),
        ).toMatchObject({ kind: "could_not_boot", where: "PR" });
    });

    it("offers a Run only when the environment is ready and Runtime is on; nothing without an environment", () => {
        expect(prRuntimeCell(runtime())).toEqual({
            kind: "not_run",
            canRequest: true,
        });
        expect(
            prRuntimeCell(
                runtime({
                    environment: {
                        environmentId: "env-1",
                        name: "x",
                        ready: false,
                        on: true,
                    },
                }),
            ),
        ).toMatchObject({ kind: "not_run", canRequest: false });
        expect(prRuntimeCell(runtime({ environment: null }))).toEqual({
            kind: "no_environment",
        });
    });

    it("marks a Run that is not on the newest commit, only when that commit came after it", () => {
        const latest = run({ headSha: SHA_A });
        expect(
            prRuntimeCell(runtime({ latest }), {
                sha: SHA_B,
                at: "2026-11-10T11:00:00.000Z",
            }),
        ).toMatchObject({ kind: "clean", stale: "aaaaaaa" });
        expect(
            staleRunSha(latest, { sha: SHA_B, at: "2026-11-10T09:00:00.000Z" }),
        ).toBeUndefined();
        expect(
            staleRunSha(latest, { sha: SHA_A.toUpperCase() }),
        ).toBeUndefined();
        expect(staleRunSha(latest, undefined)).toBeUndefined();
    });

    it("words a 5xx on an endpoint the PR adds as an error on a new endpoint, never as a regression", () => {
        // demo-shop #4 on 2026-11-13: the list said "1 regression" for a route the PR adds.
        const only = prRuntimeCell(
            runtime({
                latest: run({
                    state: "regression",
                    regressions: 0,
                    newEndpointErrors: 1,
                }),
            }),
        );
        expect(only).toEqual({
            kind: "regression",
            count: 0,
            newEndpointErrors: 1,
            runId: "run-1",
        });
        expect(failureWords(only as { count: number })).toBe(
            "1 error on a new endpoint",
        );
        expect(failureWords({ count: 2, newEndpointErrors: 3 })).toBe(
            "2 regressions · 3 errors on new endpoints",
        );
        expect(failureWords({ count: 1 })).toBe("1 regression");
    });

    it("maps each cell to the filter it matches", () => {
        expect(
            runtimeFilterOf({ kind: "regression", count: 1, runId: "r" }),
        ).toBe("regression");
        expect(runtimeFilterOf({ kind: "clean", probes: 1, runId: "r" })).toBe(
            "no_regression",
        );
        expect(runtimeFilterOf({ kind: "could_not_boot", runId: "r" })).toBe(
            "could_not_boot",
        );
        expect(runtimeFilterOf({ kind: "not_run", canRequest: false })).toBe(
            "not_run",
        );
        expect(runtimeFilterOf({ kind: "no_environment" })).toBeUndefined();
        expect(runtimeFilterOf(undefined)).toBeUndefined();
    });

    it("words the verdict chip of the PR page card", () => {
        expect(
            runVerdictWords(run({ state: "regression", regressions: 1 })),
        ).toEqual({
            label: "1 regression",
            tone: "danger",
        });
        expect(runVerdictWords(run({ state: "testing" }))).toEqual({
            label: "Running · testing",
            tone: "info",
        });
    });
});

describe("the regression in plain words", () => {
    const quantity = {
        title: "Orders page",
        field: { path: "items[0].quantity", base: "2", pr: '""' },
        differingFields: ["items[0].quantity"],
        boot: false,
        destabilizes: false,
    };

    it("names what was checked and what differs, with both values, never a route", () => {
        const sentence = regressionSentence(quantity, "main");
        expect(sentence).toContain("Orders page");
        expect(sentence).toContain("Quantity");
        expect(sentence).toContain("empty");
        expect(sentence).toContain("2 on main");
        expect(sentence).not.toMatch(/GET|POST|\/|items\[0\]/);
    });

    it("names the PR's base branch, and never guesses one when the Run recorded none", () => {
        expect(regressionSentence(quantity, "develop")).toContain("develop");
        expect(regressionSentence(quantity)).not.toContain("main");
    });

    it("tells a missing field from a new one", () => {
        const missing = regressionSentence({
            ...quantity,
            field: { path: "order.unitPrice", base: '"9.90"' },
        });
        const added = regressionSentence({
            ...quantity,
            field: { path: "discount_code", pr: '"X1"' },
        });
        expect(missing).toContain("missing");
        expect(missing).toContain("9.90");
        expect(added).toContain("new");
        expect(added).toContain("X1");
    });

    it("says the PR does not boot rather than naming a field", () => {
        const sentence = regressionSentence({
            differingFields: [],
            boot: true,
            destabilizes: true,
        });
        expect(sentence).toContain("does not boot");
    });

    it("without what Kody checked or a field, still says something plain", () => {
        const sentence = regressionSentence({
            differingFields: ["status"],
            boot: false,
            destabilizes: false,
        });
        expect(sentence).not.toMatch(/status|undefined/);
    });

    it("turns field paths and values into words", () => {
        expect(fieldWords("data.items[3].createdAt")).toBe("Created at");
        expect(valueWords("null")).toBe("empty");
        expect(valueWords(undefined)).toBe("missing");
        expect(valueWords('"open"')).toBe("open");
    });
});

describe("the timeline by commit", () => {
    it("offers a commit's link only when it is a web address", () => {
        const rows = buildCommitTimeline({
            commits: [
                { sha: SHA_A, htmlUrl: "javascript:alert(1)" },
                {
                    sha: SHA_B,
                    htmlUrl: "https://git.example.com/acme/app/commit/b",
                },
            ],
            reviews: [],
            runs: [],
        });
        const urls = rows.flatMap((r) =>
            r.kind === "commit" ? [r.commit] : r.commits,
        );
        expect(urls.find((c) => c.sha === SHA_A)?.url).toBeUndefined();
        expect(urls.find((c) => c.sha === SHA_B)?.url).toBe(
            "https://git.example.com/acme/app/commit/b",
        );
    });

    const commits = [
        {
            sha: SHA_D,
            message: "first",
            authoredAt: "2026-11-08T10:00:00.000Z",
        },
        {
            sha: SHA_C,
            message: "second\n\nbody",
            authoredAt: "2026-11-09T10:00:00.000Z",
        },
        {
            sha: SHA_B,
            message: "third",
            authoredAt: "2026-11-09T12:00:00.000Z",
        },
        { sha: SHA_A, message: "head", authoredAt: "2026-11-10T10:00:00.000Z" },
    ];

    it("puts the review and the Run of the same SHA on one commit, newest first", () => {
        const rows = buildCommitTimeline({
            commits,
            reviews: [
                {
                    sha: SHA_B,
                    at: "2026-11-09T12:05:00.000Z",
                    review: "Review 2",
                },
            ],
            runs: [
                run({
                    runId: "on-b",
                    headSha: SHA_B.toUpperCase(),
                    state: "regression",
                    regressions: 1,
                }),
            ],
        });
        expect(rows[0]).toMatchObject({
            kind: "commit",
            commit: { sha: SHA_A, isHead: true, message: "head", reviews: [] },
        });
        expect(rows[1]).toMatchObject({
            kind: "commit",
            commit: {
                sha: SHA_B,
                reviews: ["Review 2"],
                run: { runId: "on-b" },
            },
        });
    });

    it("keeps the head even when it has neither a review nor a Run (latest not run)", () => {
        const rows = buildCommitTimeline({
            commits,
            reviews: [],
            runs: [run({ headSha: SHA_D })],
        });
        expect(rows[0]).toMatchObject({
            kind: "commit",
            commit: { sha: SHA_A, isHead: true },
        });
        expect(rows[0].kind === "commit" && rows[0].commit.run).toBeUndefined();
        expect(rows[rows.length - 1]).toMatchObject({
            kind: "commit",
            commit: { sha: SHA_D, run: { headSha: SHA_D } },
        });
    });

    it("folds two or more quiet commits in a row, and lists a single one", () => {
        const folded = buildCommitTimeline({
            commits,
            reviews: [{ sha: SHA_D, review: "Review 1" }],
            runs: [],
        });
        expect(folded.map((r) => r.kind)).toEqual([
            "commit",
            "collapsed",
            "commit",
        ]);
        expect(folded[1]).toMatchObject({
            kind: "collapsed",
            commits: [{ sha: SHA_B }, { sha: SHA_C }],
        });

        const single = buildCommitTimeline({
            commits,
            reviews: [
                { sha: SHA_C, review: "Review 1" },
                { sha: SHA_D, review: "Review 0" },
            ],
            runs: [],
        });
        expect(single.map((r) => r.kind)).toEqual([
            "commit",
            "commit",
            "commit",
            "commit",
        ]);
    });

    it("lists what Kody saw off the branch", () => {
        const rows = buildCommitTimeline({
            commits: [{ sha: SHA_A, message: "head" }],
            reviews: [
                { sha: SHA_B, at: "2026-11-09T00:00:00.000Z", review: "on b" },
            ],
            runs: [
                run({
                    headSha: SHA_C,
                    requestedAt: "2026-11-09T05:00:00.000Z",
                }),
            ],
        });
        expect(
            rows.map((r) =>
                r.kind === "commit" ? (r.commit.sha ?? "none") : "fold",
            ),
        ).toEqual([SHA_A, SHA_C, SHA_B]);
        expect(rows[1]).toMatchObject({ commit: { onBranch: false } });
    });

    it("puts a review that recorded no commit on the commit that was latest when it ran", () => {
        const rows = buildCommitTimeline({
            commits: [
                { sha: SHA_A, authoredAt: "2026-11-09T00:00:00.000Z" },
                { sha: SHA_B, authoredAt: "2026-11-10T00:00:00.000Z" },
            ],
            reviews: [
                { sha: SHA_B, at: "2026-11-10T01:00:00.000Z", review: "on b" },
                { sha: null, at: "2026-11-09T12:00:00.000Z", review: "no sha" },
            ],
            runs: [],
        });
        const commits = rows.flatMap((r) =>
            r.kind === "commit" ? [r.commit] : r.commits,
        );
        expect(commits.map((c) => c.sha)).toEqual([SHA_B, SHA_A]);
        expect(commits[1]).toMatchObject({
            reviews: ["no sha"],
            unrecordedReviews: ["no sha"],
        });
        expect(commits.some((c) => !c.sha)).toBe(false);
    });

    it("puts a review that recorded no commit and no time on the head, newest first with the others", () => {
        const rows = buildCommitTimeline({
            commits: [{ sha: SHA_A }],
            reviews: [
                { sha: null, review: "newest, no sha" },
                { sha: SHA_A, at: "2026-11-09T00:00:00.000Z", review: "on a" },
            ],
            runs: [],
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            commit: { sha: SHA_A, reviews: ["newest, no sha", "on a"] },
        });
    });

    it("keeps a review that recorded no commit on its own row only when no commit is known", () => {
        const rows = buildCommitTimeline({
            reviews: [{ sha: null, review: "no sha" }],
            runs: [],
        });
        expect(rows).toEqual([
            {
                kind: "commit",
                commit: {
                    isHead: false,
                    onBranch: true,
                    reviews: ["no sha"],
                    unrecordedReviews: ["no sha"],
                },
            },
        ]);
    });

    it("without the branch's commits, marks the head from the latest review", () => {
        const rows = buildCommitTimeline({
            reviews: [
                { sha: SHA_B, at: "2026-11-10T00:00:00.000Z", review: "r" },
            ],
            runs: [
                run({
                    headSha: SHA_C,
                    requestedAt: "2026-11-09T00:00:00.000Z",
                }),
            ],
            headSha: SHA_B,
        });
        expect(
            rows.map(
                (r) =>
                    r.kind === "commit" && [
                        r.commit.sha,
                        r.commit.isHead,
                        r.commit.onBranch,
                    ],
            ),
        ).toEqual([
            [SHA_B, true, true],
            [SHA_C, false, true],
        ]);
    });
});

describe("a PR whose repository is in several environments", () => {
    const platform = {
        environmentId: "env-platform",
        name: "acme/platform",
        ready: true,
        on: true,
        role: "member" as const,
        triggers: true,
    };
    const own = {
        environmentId: "env-1",
        name: "acme/auth",
        ready: true,
        on: true,
        role: "primary" as const,
        triggers: true,
    };
    const checkout = {
        environmentId: "env-checkout",
        name: "acme/checkout",
        ready: false,
        on: true,
        role: "member" as const,
        triggers: false,
    };
    const several = (patch: Partial<PrRuntime> = {}) =>
        runtime({
            environment: own,
            environments: [own, platform, checkout],
            ...patch,
        });

    it("shows the verdict of the environment the repository is the primary of, not the newest of any", () => {
        const ownRun = run({
            runId: "own",
            environmentId: "env-1",
            state: "regression",
            regressions: 2,
            requestedAt: "2026-11-10T10:00:00.000Z",
        });
        const platformRun = run({
            runId: "platform",
            environmentId: "env-platform",
            headSha: SHA_B,
            requestedAt: "2026-11-10T11:00:00.000Z",
        });
        const r = several({
            latest: platformRun,
            commits: [platformRun, ownRun],
        });
        expect(mainRunOf(r)?.runId).toBe("own");
        expect(prRuntimeCell(r)).toMatchObject({
            kind: "regression",
            count: 2,
            runId: "own",
        });
    });

    it("falls back to the latest Run when the main environment's is not in the answer", () => {
        const platformRun = run({
            runId: "platform",
            environmentId: "env-platform",
        });
        const r = several({ latest: platformRun, commits: [platformRun] });
        expect(mainRunOf(r)?.runId).toBe("platform");
        expect(environmentNameOf(r, "env-platform")).toBe("acme/platform");
    });

    it("lists the other environments with their own verdict, or why they have none", () => {
        const platformRun = run({
            runId: "platform",
            environmentId: "env-platform",
            state: "could_not_boot",
            bootFailureSide: "base",
        });
        const others = otherEnvironmentsOf(
            several({ latest: platformRun, commits: [platformRun] }),
        );
        expect(others.map((o) => [o.name, otherEnvironmentWords(o)])).toEqual([
            ["acme/platform", "Could not boot · environment"],
            ["acme/checkout", "does not run this repository's PRs"],
        ]);
        expect(otherEnvironmentsOf(runtime())).toEqual([]);
    });

    it("offers Run on this PR when any environment that runs its PRs is ready", () => {
        expect(canRequestRun(several())).toBe(true);
        expect(
            canRequestRun(
                several({
                    environment: { ...own, ready: false },
                    environments: [{ ...own, ready: false }, checkout],
                }),
            ),
        ).toBe(false);
        expect(
            prRuntimeCell(
                several({
                    environments: [{ ...own, ready: false }, platform],
                }),
            ),
        ).toEqual({ kind: "not_run", canRequest: true });
        // One environment reads as before: no role, no triggers.
        expect(canRequestRun(runtime())).toBe(true);
        expect(
            canRequestRun(
                runtime({
                    environment: {
                        environmentId: "e",
                        name: "n",
                        ready: true,
                        on: false,
                    },
                }),
            ),
        ).toBe(false);
    });
});

describe("Run on this PR, as the API decides it", () => {
    const env = (patch: Partial<PrRuntimeEnvironment> = {}) => ({
        environmentId: "env-1",
        name: "acme/shop",
        ready: true,
        on: true,
        triggers: true,
        repositoryIds: ["repo-1"],
        ...patch,
    });

    it("offers no Run when the API says none can start, even with a ready environment", () => {
        const r = runtime({ environment: env(), canRequestRun: false });
        expect(canRequestRun(r)).toBe(false);
        expect(prRuntimeCell(r)).toMatchObject({
            kind: "not_run",
            canRequest: false,
        });
        expect(canRequestRun(runtime({ canRequestRun: true }))).toBe(true);
    });

    it("needs the right to start Runs on every repository of each environment that would run, the PR's own first", () => {
        const platform = env({
            environmentId: "env-platform",
            role: "member",
            repositoryIds: ["repo-platform", "repo-1", "repo-billing"],
        });
        const own = env({ role: "primary", repositoryIds: ["repo-1"] });
        const holdsOnly = env({
            environmentId: "env-checkout",
            role: "member",
            triggers: false,
            repositoryIds: ["repo-checkout", "repo-1"],
        });
        expect(
            requestRunRepositoryIds(
                runtime({
                    environment: own,
                    environments: [own, platform, holdsOnly],
                }),
            ),
        ).toEqual(["repo-1", "repo-platform", "repo-billing"]);
        expect(
            requestRunRepositoryIds(
                runtime({ environment: env({ repositoryIds: undefined }) }),
            ),
        ).toEqual(["repo-1"]);
    });

    it("says why a Run cannot be asked when the answer tells", () => {
        const reason = (patch: Partial<PrRuntimeEnvironment>) =>
            cannotRequestRunReason(
                runtime({ environment: env(patch), canRequestRun: false }),
            );
        expect(reason({ triggers: false })).toMatch(
            /no environment runs this repository's pull requests/i,
        );
        expect(reason({ on: false })).toMatch(/off for this repository/i);
        expect(reason({ ready: false })).toMatch(/not ready/i);
        // A member's PR: the environment is off by its primary's mode, never by the member's own.
        expect(
            reason({ on: false, repositoryIds: ["repo-shop", "repo-1"] }),
        ).toBe(
            "Kody Runtime is off for the environment of acme/shop. Turn it on in acme/shop's Kody Runtime settings.",
        );
        // Ready, on and triggering: nothing this screen can name.
        expect(reason({})).toBeUndefined();
        expect(
            cannotRequestRunReason(runtime({ canRequestRun: true })),
        ).toBeUndefined();
        expect(
            cannotRequestRunReason(runtime({ environment: null })),
        ).toBeUndefined();
    });

    it("labels a Run that waits for room as waiting for a host", () => {
        expect(livePhaseLabel({ state: "booting", phase: "capacity" })).toBe("waiting for a host");
        expect(livePhaseLabel({ state: "booting", phase: "booting" })).toBe("booting");
    });
});
