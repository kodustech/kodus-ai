import {
    backoffMs,
    changedEnvironmentIds,
    environmentsRefetchInterval,
    isRunBeingRecorded,
    NEW_RUN_GRACE_MS,
    previewCardRefetchInterval,
    PUBLICATION_WATCH_MS,
    runRefetchInterval,
    runsListRefetchInterval,
    startedRunIdsOf,
    STUCK_SETUP_MS,
} from "./polling";

const now = Date.parse("2026-11-01T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("runRefetchInterval", () => {
    it("never polls a terminal Run, or one not loaded", () => {
        expect(
            runRefetchInterval(
                { state: "regression", updatedAt: ago(0) },
                { now },
            ),
        ).toBe(false);
        expect(runRefetchInterval(null, { now })).toBe(false);
        expect(runRefetchInterval(undefined, { now })).toBe(false);
    });

    it("keeps asking after the end while the result is not settled on the PR, for a while only", () => {
        const unsettled = { settled: false };
        expect(
            runRefetchInterval(
                { state: "partly_tested", finishedAt: ago(60_000), publication: unsettled },
                { now },
            ),
        ).toBe(15_000);
        expect(
            runRefetchInterval(
                { state: "partly_tested", finishedAt: ago(60_000), publication: { settled: true } },
                { now },
            ),
        ).toBe(false);
        expect(
            runRefetchInterval(
                { state: "partly_tested", finishedAt: ago(PUBLICATION_WATCH_MS), publication: unsettled },
                { now },
            ),
        ).toBe(false);
        // An API without the publication record: as before, never once terminal.
        expect(
            runRefetchInterval({ state: "partly_tested", finishedAt: ago(0) }, { now }),
        ).toBe(false);
    });

    it("polls a live Run fast while it moves, then backs off", () => {
        expect(
            runRefetchInterval(
                { state: "testing", updatedAt: ago(10_000) },
                { now },
            ),
        ).toBe(5_000);
        expect(
            runRefetchInterval(
                { state: "testing", updatedAt: ago(5 * 60_000) },
                { now },
            ),
        ).toBe(15_000);
        expect(
            runRefetchInterval(
                { state: "awaiting_approval", updatedAt: ago(60 * 60_000) },
                { now },
            ),
        ).toBe(60_000);
    });

    it("doubles after failed fetches, up to a minute", () => {
        expect(
            runRefetchInterval(
                { state: "booting", updatedAt: ago(0) },
                { now, failures: 2 },
            ),
        ).toBe(20_000);
        expect(
            runRefetchInterval(
                { state: "booting", updatedAt: ago(0) },
                { now, failures: 10 },
            ),
        ).toBe(60_000);
    });
});

describe("a Run the user just started", () => {
    const startedAt = now - 5_000;

    it("keeps asking for it while the worker has not recorded it yet", () => {
        expect(
            runRefetchInterval(null, { now, startedAt, answeredAt: now }),
        ).not.toBe(false);
    });

    it("stops asking a minute after it was started", () => {
        const late = startedAt + NEW_RUN_GRACE_MS;
        expect(
            runRefetchInterval(null, { now: late, startedAt, answeredAt: late }),
        ).toBe(false);
    });

    it("reads as being recorded until the last answer comes a minute after the start, then as not found", () => {
        expect(isRunBeingRecorded(startedAt, startedAt + 30_000)).toBe(true);
        expect(
            isRunBeingRecorded(startedAt, startedAt + NEW_RUN_GRACE_MS),
        ).toBe(false);
    });

    it("an id nobody started from this page reads as not found at once", () => {
        expect(isRunBeingRecorded(undefined, now)).toBe(false);
        expect(runRefetchInterval(null, { now, answeredAt: now })).toBe(false);
    });

    it("every Run a start queued counts as just started, one or one per environment", () => {
        expect(startedRunIdsOf({ runId: "r2" })).toEqual(["r2"]);
        expect(
            startedRunIdsOf({
                runId: "a",
                runs: [
                    { runId: "a" },
                    { runId: "b" },
                ],
            }),
        ).toEqual(["a", "b"]);
        expect(startedRunIdsOf(undefined)).toEqual([]);
    });
});

describe("runsListRefetchInterval", () => {
    it("polls only while a Run of the list is live", () => {
        expect(
            runsListRefetchInterval([
                { state: "no_regressions" },
                { state: "testing" },
            ]),
        ).toBe(10_000);
        expect(runsListRefetchInterval([{ state: "no_regressions" }])).toBe(
            false,
        );
        expect(runsListRefetchInterval(null)).toBe(false);
    });
});

describe("environmentsRefetchInterval", () => {
    it("polls while a setup is requested or running, from the merged state", () => {
        expect(
            environmentsRefetchInterval(
                [{ state: "setup_requested", updatedAt: ago(1_000) }],
                { now },
            ),
        ).toBe(3_000);
        expect(
            environmentsRefetchInterval(
                [{ state: "active" }, { state: "blocked" }],
                { now },
            ),
        ).toBe(false);
        expect(environmentsRefetchInterval(undefined, { now })).toBe(false);
    });

    it("a rebuild of an old setup counts from the new request, not the old record", () => {
        expect(
            environmentsRefetchInterval(
                [
                    {
                        state: "setup_requested",
                        updatedAt: ago(2_000),
                        setup: {
                            state: "active",
                            steps: [],
                            blockers: [],
                            requestedAt: ago(9e7),
                            updatedAt: ago(9e7),
                        },
                    },
                ],
                { now },
            ),
        ).toBe(3_000);
    });

    it("slows to once a minute when the setup looks stuck", () => {
        expect(
            environmentsRefetchInterval(
                [{ state: "setting_up", updatedAt: ago(STUCK_SETUP_MS + 1) }],
                { now },
            ),
        ).toBe(60_000);
    });
});

describe("runRefetchInterval while the stream is live", () => {
    it("falls back to once a minute: the stream refreshes the Run on each state event", () => {
        const run = { state: "testing" as const, updatedAt: new Date(now - 1_000).toISOString() };
        expect(runRefetchInterval(run, { now })).toBe(5_000);
        expect(runRefetchInterval(run, { now, streamLive: true })).toBe(60_000);
        // Terminal: the publication watch is the same, live stream or not.
        expect(runRefetchInterval({ state: "no_regressions", finishedAt: new Date(now).toISOString(), publication: { settled: false } }, { now, streamLive: true })).toBe(15_000);
    });
});

describe("changedEnvironmentIds", () => {
    const setup = (state: "setting_up" | "active", updatedAt: string, progressAt?: string) => ({
        state,
        updatedAt,
        ...(progressAt ? { progress: { updatedAt: progressAt } } : {}),
    });

    it("names the environments whose state, setup or live progress moved", () => {
        const shown = [
            { environmentId: "a", state: "setting_up" as const, setup: setup("setting_up", "t1", "p1") },
            { environmentId: "b", state: "setting_up" as const, setup: setup("setting_up", "t1", "p1") },
            { environmentId: "c", state: "active" as const },
        ];
        const statuses = [
            { environmentId: "a", state: "setting_up" as const, setup: setup("setting_up", "t1", "p1") },
            { environmentId: "b", state: "setting_up" as const, setup: setup("setting_up", "t1", "p2") },
            { environmentId: "c", state: "setup_requested" as const },
        ];
        expect(changedEnvironmentIds(shown, statuses, { complete: true })).toEqual(["b", "c"]);
    });

    // The worker records a booting setup's progress every few seconds. The list shows no progress, so it is
    // read again only when a state or a setup moves, never on each progress tick (perf N2).
    it("leaves live progress out when asked to, as the list does", () => {
        const shown = [{ environmentId: "a", state: "setting_up" as const, setup: setup("setting_up", "t1", "p1") }];
        const ticked = [{ environmentId: "a", state: "setting_up" as const, setup: setup("setting_up", "t1", "p2") }];
        const moved = [{ environmentId: "a", state: "setting_up" as const, setup: setup("setting_up", "t2", "p2") }];
        expect(changedEnvironmentIds(shown, ticked, { complete: true, progress: false })).toEqual([]);
        expect(changedEnvironmentIds(shown, moved, { complete: true, progress: false })).toEqual(["a"]);
        expect(changedEnvironmentIds(shown, ticked, { complete: false })).toEqual(["a"]);
    });

    it("ignores an old progress of a finished setup, which the status does not carry", () => {
        const shown = [{ environmentId: "a", state: "active" as const, setup: setup("active", "t1", "p1") }];
        const statuses = [{ environmentId: "a", state: "active" as const, setup: setup("active", "t1") }];
        expect(changedEnvironmentIds(shown, statuses, { complete: true })).toEqual([]);
    });

    it("counts an environment the list does not show yet only when the views are the whole list", () => {
        const statuses = [{ environmentId: "new", state: "setup_requested" as const }];
        expect(changedEnvironmentIds([], statuses, { complete: true })).toEqual(["new"]);
        expect(changedEnvironmentIds([], statuses, { complete: false })).toEqual([]);
    });
});

describe("backoffMs", () => {
    it("doubles per failure and stops at the cap", () => {
        expect(backoffMs(1000, 0, 8000)).toBe(1000);
        expect(backoffMs(1000, 3, 8000)).toBe(8000);
        expect(backoffMs(1000, 9, 8000)).toBe(8000);
    });
});

describe("previewCardRefetchInterval", () => {
    it("reads a starting side often and an open one once a minute", () => {
        expect(previewCardRefetchInterval([{ state: "starting" }])).toBe(4_000);
        expect(previewCardRefetchInterval([{ state: "ready" }, undefined])).toBe(60_000);
        expect(previewCardRefetchInterval([{ state: "sleeping" }])).toBe(60_000);
    });

    it("stops when no preview exists or every one has ended", () => {
        expect(previewCardRefetchInterval([])).toBe(false);
        expect(previewCardRefetchInterval([undefined])).toBe(false);
        expect(
            previewCardRefetchInterval([{ state: "stopped" }, { state: "expired" }]),
        ).toBe(false);
    });
});

describe("runsListRefetchInterval for a live Run that has gone quiet", () => {
    const live = (at: string) => [{ state: "testing" as const, requestedAt: at }];

    it("backs off as the newest live Run ages, and stops for one older than any Run lasts", () => {
        expect(runsListRefetchInterval(live(ago(60_000)), { now })).toBe(10_000);
        expect(runsListRefetchInterval(live(ago(30 * 60_000)), { now })).toBe(30_000);
        expect(runsListRefetchInterval(live(ago(3 * 3_600_000)), { now })).toBe(60_000);
        expect(runsListRefetchInterval(live(ago(7 * 3_600_000)), { now })).toBe(false);
    });
});
